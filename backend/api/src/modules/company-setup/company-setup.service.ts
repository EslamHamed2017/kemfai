import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { AuditService } from '../audit/audit.service';
import { CompanyOdooContextService } from './company-odoo-context.service';
import {
  CompanyMutationHandoffRow,
  CompanyMutationHandoffService,
} from './company-mutation-handoff.service';
import { CompanyMutationHandoffState } from './entities/company-mutation-handoff.entity';
import { stripKemfaiPrefix } from './kemfai-error.util';
import {
  CompanySetupStateDto,
  CompanySetupStepRequestDto,
} from './dto/company-setup-step.request.dto';

interface OdooCompanySetupState {
  currentStep: string;
  setupComplete: boolean;
  values: Record<string, unknown>;
  version: number;
  stale: boolean;
}

interface OdooCompanySetupCompleteResult extends OdooCompanySetupState {
  alreadyComplete: boolean;
}

/**
 * GET/PUT `/companies/current/setup` (T054). Every call resolves the caller's tenant
 * (never a client-supplied tenant id — TenantContextResolver, same source TenantScopeGuard
 * already used for this request), loads that tenant's Odoo database name, and reaches the
 * `res.company` RPC surface added in `backend/addons/kemfai_company_setup/models/company.py`
 * (`kemfai_setup_get_state` / `kemfai_setup_save_step`). This service holds no business
 * logic of its own beyond that plumbing and typed-error translation (arbiter resolution
 * point 3): all VAT regex evaluation and field/country validation live in the Odoo addon.
 */
@Injectable()
export class CompanySetupService {
  constructor(
    private readonly context: CompanyOdooContextService,
    private readonly odoo: OdooRpcService,
    private readonly auditService: AuditService,
    private readonly handoffs: CompanyMutationHandoffService,
  ) {}

  async getState(req: TenantScopedRequest): Promise<CompanySetupStateDto> {
    const { db, uid, password, companyId } = await this.context.resolve(req);
    const result = await this.callOrTranslate(() =>
      this.odoo.executeKw(db, uid, password, 'res.company', 'kemfai_setup_get_state', [
        [companyId],
      ]),
    );
    return this.toDto(result);
  }

  async saveStep(
    req: TenantScopedRequest,
    body: CompanySetupStepRequestDto,
  ): Promise<CompanySetupStateDto> {
    const { db, uid, password, companyId } = await this.context.resolve(req);
    const result = await this.callOrTranslate(() =>
      this.odoo.executeKw(db, uid, password, 'res.company', 'kemfai_setup_save_step', [
        [companyId],
        body.step,
        body.values,
        body.baseVersion ?? null,
      ]),
    );
    return this.toDto(result);
  }

  /**
   * T055 — `POST /companies/current/setup/complete` (FR-028, Acceptance Scenario 3.7).
   * The Odoo addon (`kemfai_setup_complete`) is the sole authority on whether completion
   * is allowed — it re-derives "all required steps submitted" from persisted `res.company`
   * fields under a row lock, never from anything this request's caller supplies.
   *
   * Durable-handoff remediation (T055 arbiter binding resolution): a
   * `company_mutation_handoff` row — at most one per tenant, ever
   * (`uq_company_mutation_handoff_completion`) — is committed to the control-plane
   * database BEFORE the Odoo RPC runs. Every completion request for this tenant, whatever
   * HTTP request carries it, resolves to this SAME row/operation UUID
   * (`CompanyMutationHandoffService.findOrCreateCompletionHandoff`), which is what makes
   * "exactly one `company.setup.completed` event per actual completion" (AC3.7) hold even
   * under concurrent/retried requests with different-or-no client keys. The Odoo RPC
   * itself is idempotent on that same operation UUID
   * (`kemfai_setup_complete`'s receipt table): a repeat never re-applies the mutation.
   * If the handoff is already `audited`, this method short-circuits entirely — no RPC,
   * no re-audit, just the originally stored response. If it is `odoo_committed` (Odoo
   * already ran for this handoff but the audit append never completed — crash, audit-
   * store failure, or lost response), this call skips straight to appending the audit
   * event from the handoff's own persisted actor/time, never a later retrying caller's.
   * `CompanyMutationRecoveryWorker` performs the identical recovery autonomously, without
   * requiring any of this to be triggered by a client request at all.
   */
  async completeSetup(req: TenantScopedRequest): Promise<CompanySetupStateDto> {
    const { db, uid, password, companyId } = await this.context.resolve(req);
    const tenantContext = await this.context.resolveTenantContext(req);
    if (!tenantContext.accountId || !tenantContext.callerTenantId) {
      throw new InternalServerErrorException('No account/tenant resolved for this request');
    }

    const handoff = await this.handoffs.findOrCreateCompletionHandoff({
      tenantId: tenantContext.callerTenantId,
      actorAccountId: tenantContext.accountId,
      principalIdentity: tenantContext.keycloakUserId,
      odooDbName: db,
      odooCompanyId: companyId,
      requestFingerprint: 'setup.complete',
      requestPayload: {},
    });

    if (handoff.state === CompanyMutationHandoffState.AUDITED) {
      return this.toDto(handoff.finalResponse);
    }

    const result = await this.runOdooCompletion(handoff, db, uid, password, companyId);

    await this.auditService.recordCompanySetupCompleted({
      accountId: handoff.actorAccountId,
      tenantId: handoff.tenantId,
      // AuditEvent.subject_id is a Postgres `uuid` column; Odoo's res.company id is a
      // plain integer and the control plane has no separate UUID "Company" entity
      // (Company lives only inside the tenant's own Odoo database, 1:1 with Tenant) —
      // the tenant's own id is the correct, and only available, UUID subject here. The
      // actual Odoo source (tenant DB name + res.company.id) is recorded explicitly in
      // the payload below instead.
      companyId: handoff.tenantId,
      odooDbName: handoff.odooDbName,
      odooCompanyId: handoff.odooCompanyId,
      occurredAt: handoff.occurredAt,
      operationUuid: handoff.id,
    });
    await this.handoffs.markAudited(handoff.id);

    return this.toDto(result);
  }

  private async runOdooCompletion(
    handoff: CompanyMutationHandoffRow,
    db: string,
    uid: number,
    password: string,
    companyId: number,
  ): Promise<OdooCompanySetupCompleteResult> {
    if (handoff.state === CompanyMutationHandoffState.ODOO_COMMITTED) {
      return handoff.finalResponse as OdooCompanySetupCompleteResult;
    }

    let result: OdooCompanySetupCompleteResult;
    try {
      result = (await this.odoo.executeKw(
        db,
        uid,
        password,
        'res.company',
        'kemfai_setup_complete',
        [[companyId], handoff.id, handoff.occurredAt.toISOString(), handoff.actorAccountId],
      )) as OdooCompanySetupCompleteResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isKnownOdooFault(message)) {
        // A typed Odoo business/validation ValidationError (e.g. required steps still
        // missing) — the addon (models/company.py 245-443) raises these BEFORE taking
        // the row lock / committing anything for kemfai_setup_complete, so nothing was
        // committed at Odoo for THIS handoff. Safe to free the tenant's single
        // completion slot so a later genuinely-complete attempt is not blocked.
        await this.handoffs.deletePending(handoff.id);
        this.translateFault(message);
      }
      // Any other failure (transport error, lost/aborted response, timeout, or any
      // unrecognized error shape) is AMBIGUOUS: Odoo may already have committed the
      // mutation and its same-transaction receipt for this operation UUID before the
      // response was lost — a typed fault after commit cannot occur here, since Odoo
      // raises faults before committing. NEVER delete the handoff in this branch; leave
      // it claimable (retryable, with next_attempt_at advanced) so
      // CompanyMutationRecoveryWorker resolves it autonomously via receipt replay on
      // the SAME operation UUID (arbiter P1/P4/P5), instead of losing the only
      // control-plane recovery anchor.
      await this.handoffs.scheduleRetryBackoff(handoff.id, 0);
      throw new InternalServerErrorException(
        'Company setup completion could not be confirmed and will be retried automatically',
      );
    }

    await this.handoffs.markOdooCommitted(handoff.id, result);
    return result;
  }

  /**
   * Translates the addon's `KEMFAI_<CODE>: ...` prefixed `ValidationError` messages
   * (the only typed-error channel a JSON-RPC fault carries, see
   * `odoo-rpc-client.ts`'s `body.error.data?.message`) into the documented HTTP responses
   * — 409 for a missing country validation rule (configuration gap, never silently
   * accepted), 422 for every other field-level failure. An unrecognized Odoo error never
   * becomes a leaked 500 message; it is replaced with a generic one.
   */
  private async callOrTranslate<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.translateFault(message);
    }
  }

  /**
   * True only for the addon's `KEMFAI_<CODE>: ...`-prefixed `ValidationError` messages
   * (the sole typed-fault channel a JSON-RPC fault carries — `odoo-rpc-client.ts`'s
   * `body.error.data?.message`). Every one of these is raised by
   * `models/company.py` (245-443) BEFORE the row lock / mutation commit, so a message
   * that does not match any of them is never a known pre-commit business fault — it is
   * either a transport-level failure or an unrecognized shape, both of which must be
   * treated as ambiguous (B1: see `runOdooCompletion`'s catch block).
   */
  private isKnownOdooFault(message: string): boolean {
    return (
      message.includes('KEMFAI_CONFIG_GAP') ||
      message.includes('KEMFAI_VAT_FORMAT') ||
      message.includes('KEMFAI_REQUIRED_FIELD') ||
      message.includes('KEMFAI_UNKNOWN_STEP') ||
      message.includes('KEMFAI_INVALID_COUNTRY') ||
      message.includes('KEMFAI_INVALID_CURRENCY') ||
      message.includes('KEMFAI_INVALID_INDUSTRY') ||
      message.includes('KEMFAI_INVALID_PAYLOAD') ||
      // T055: one or more required wizard steps are still unsubmitted
      // (contracts/openapi.yaml documents 422 for this on /setup/complete —
      // distinct from the 409 CompanySetupIncompleteError the SAME Odoo error
      // code maps to on /companies/current/settings, see company-settings.service.ts).
      message.includes('KEMFAI_SETUP_INCOMPLETE')
    );
  }

  private translateFault(message: string): never {
    if (message.includes('KEMFAI_CONFIG_GAP')) {
      throw new ConflictException('No VAT/tax validation rule is configured for this country');
    }
    if (
      message.includes('KEMFAI_VAT_FORMAT') ||
      message.includes('KEMFAI_REQUIRED_FIELD') ||
      message.includes('KEMFAI_UNKNOWN_STEP') ||
      message.includes('KEMFAI_INVALID_COUNTRY') ||
      message.includes('KEMFAI_INVALID_CURRENCY') ||
      message.includes('KEMFAI_INVALID_INDUSTRY') ||
      message.includes('KEMFAI_INVALID_PAYLOAD') ||
      message.includes('KEMFAI_SETUP_INCOMPLETE')
    ) {
      throw new UnprocessableEntityException(stripKemfaiPrefix(message));
    }
    // Never pass through a raw Odoo/RPC error: it can contain internal detail.
    throw new InternalServerErrorException('Company setup is temporarily unavailable');
  }

  private toDto(result: unknown): CompanySetupStateDto {
    const state = result as OdooCompanySetupState;
    return {
      currentStep: state.currentStep,
      setupComplete: state.setupComplete,
      values: state.values,
      version: state.version,
      stale: state.stale,
    };
  }
}
