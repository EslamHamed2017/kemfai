import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { fingerprintOf, scopeOf } from '../../common/interceptors/idempotency.interceptor';
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
  CompanySettingsUpdateRequestDto,
  CompanySettingsViewDto,
} from './dto/company-settings.request.dto';

const SETTINGS_ROUTE = '/companies/current/settings';

interface OdooCompanySettingsView {
  values: Record<string, unknown>;
  setupComplete: boolean;
}

interface OdooCompanySettingsUpdateResult extends OdooCompanySettingsView {
  changedFields: string[];
}

/**
 * GET/PUT `/companies/current/settings` (T055, FR-028, F3 remediation/T106 scope pulled
 * forward because FR-028's own acceptance test — "values remain editable afterward
 * through company settings, not only by re-running the wizard" — is otherwise
 * unverifiable). A distinct, post-completion-only surface over the same
 * wizard-captured fields as `CompanySetupService`; it never re-runs the wizard's
 * step/version/resume bookkeeping and never touches `setup_wizard_version` (T054's
 * concurrency contract for the wizard itself is unaffected by this surface).
 *
 * `setup_complete` is read fresh from the Odoo addon on every call (`kemfai_settings_get`/
 * `kemfai_settings_update` both re-check the persisted column under this request's own
 * transaction) — never cached, never trusted from a prior response or client flag.
 */
@Injectable()
export class CompanySettingsService {
  constructor(
    private readonly context: CompanyOdooContextService,
    private readonly odoo: OdooRpcService,
    private readonly auditService: AuditService,
    private readonly handoffs: CompanyMutationHandoffService,
  ) {}

  async getSettings(req: TenantScopedRequest): Promise<CompanySettingsViewDto> {
    const { db, uid, password, companyId } = await this.context.resolve(req);
    const result = await this.callOrTranslate(() =>
      this.odoo.executeKw(db, uid, password, 'res.company', 'kemfai_settings_get', [[companyId]]),
    );
    return this.toDto(result);
  }

  /**
   * Durable-handoff remediation (T055 arbiter binding resolution, point 5): a
   * `company_mutation_handoff` row is committed BEFORE the Odoo RPC runs, exactly like
   * `CompanySetupService.completeSetup`. Unlike completion, settings edits are NOT
   * capped at one-per-tenant — each logical edit gets its own operation UUID — but the
   * optional `Idempotency-Key` header still resolves repeats of the SAME logical edit to
   * the SAME handoff:
   *
   * - same scoped key (authenticated caller + tenant + method + route + key) and the
   *   SAME request fingerprint → returns the stored response (no second mutation, no
   *   second audit row — the handoff's own operation-UUID receipt on the Odoo side and
   *   the audit dedupe key both anchor on this one handoff's id);
   * - same scoped key with a DIFFERENT fingerprint → 409, never silently applied as if
   *   it were the original edit;
   * - absent key → a brand-new handoff/operation UUID every call: a distinct new intent,
   *   never collapsed with any other call, exactly like the pre-handoff behavior;
   * - two DIFFERENT authorized callers who happen to reuse the same textual key are never
   *   collapsed into one handoff/event: the uniqueness is scoped by `scopeOf(req)`
   *   (authenticated caller + tenant), the SAME scope `IdempotencyKeyInterceptor` uses,
   *   not the raw key string alone (the prior review finding this remediates).
   *
   * The audit event's actor/time/changedFields always come from the handoff — never a
   * later retrying caller — and `CompanyMutationRecoveryWorker` can finish an interrupted
   * edit (Odoo committed, audit never appended) without any further client request.
   */
  async updateSettings(
    req: TenantScopedRequest,
    body: CompanySettingsUpdateRequestDto,
  ): Promise<CompanySettingsViewDto> {
    const { db, uid, password, companyId } = await this.context.resolve(req);
    const tenantContext = await this.context.resolveTenantContext(req);
    if (!tenantContext.accountId || !tenantContext.callerTenantId) {
      throw new InternalServerErrorException('No account/tenant resolved for this request');
    }

    const idempotencyHeader = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(idempotencyHeader)
      ? idempotencyHeader[0]
      : idempotencyHeader;
    const callerScope = scopeOf(req);
    const fingerprint = fingerprintOf(body.values);

    const handoff = await this.handoffs.findOrCreateSettingsHandoff({
      tenantId: tenantContext.callerTenantId,
      actorAccountId: tenantContext.accountId,
      principalIdentity: tenantContext.keycloakUserId,
      odooDbName: db,
      odooCompanyId: companyId,
      requestFingerprint: fingerprint,
      requestPayload: body.values,
      idempotencyKey: idempotencyKey ?? null,
      callerScope,
      method: 'PUT',
      route: SETTINGS_ROUTE,
    });

    if (handoff.state === CompanyMutationHandoffState.AUDITED) {
      return this.toDto(handoff.finalResponse);
    }

    const result = await this.runOdooUpdate(handoff, body, db, uid, password, companyId);

    await this.auditService.recordCompanySettingsUpdated({
      accountId: handoff.actorAccountId,
      tenantId: handoff.tenantId,
      // See the identical note in CompanySetupService.completeSetup: subject_id is a
      // Postgres uuid column and there is no separate UUID "Company" entity in the
      // control plane, so the tenant's own id is the correct subject here.
      companyId: handoff.tenantId,
      odooDbName: handoff.odooDbName,
      odooCompanyId: handoff.odooCompanyId,
      changedFields: result.changedFields,
      occurredAt: handoff.occurredAt,
      operationUuid: handoff.id,
    });
    await this.handoffs.markAudited(handoff.id);

    return this.toDto(result);
  }

  private async runOdooUpdate(
    handoff: CompanyMutationHandoffRow,
    body: CompanySettingsUpdateRequestDto,
    db: string,
    uid: number,
    password: string,
    companyId: number,
  ): Promise<OdooCompanySettingsUpdateResult> {
    if (handoff.state === CompanyMutationHandoffState.ODOO_COMMITTED) {
      return handoff.finalResponse as OdooCompanySettingsUpdateResult;
    }

    let result: OdooCompanySettingsUpdateResult;
    try {
      result = (await this.odoo.executeKw(
        db,
        uid,
        password,
        'res.company',
        'kemfai_settings_update',
        [
          [companyId],
          body.values,
          handoff.id,
          handoff.occurredAt.toISOString(),
          handoff.actorAccountId,
        ],
      )) as OdooCompanySettingsUpdateResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isKnownOdooFault(message)) {
        // A typed Odoo business/validation ValidationError — the addon
        // (models/company.py 245-443) raises these BEFORE taking the row lock /
        // committing anything for kemfai_settings_update, so nothing was committed at
        // Odoo for THIS handoff. Release it so a retry (same key, corrected payload, or
        // a brand-new edit) is never blocked by this failed attempt.
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
      // the SAME operation UUID (arbiter P1/P4/P5).
      await this.handoffs.scheduleRetryBackoff(handoff.id, 0);
      throw new InternalServerErrorException(
        'Company settings update could not be confirmed and will be retried automatically',
      );
    }

    await this.handoffs.markOdooCommitted(handoff.id, result);
    return result;
  }

  /**
   * Translates the addon's `KEMFAI_<CODE>: ...` prefixed `ValidationError`s. The one
   * mapping that differs from `CompanySetupService`'s translator: `KEMFAI_SETUP_INCOMPLETE`
   * becomes THE canonical 409 `CompanySetupIncompleteError` body documented on this path
   * (contracts/openapi.yaml) — not the 422 that same Odoo error code maps to on
   * `/companies/current/setup/complete`, and not a bare string message either, since the
   * contract's schema requires `statusCode`/`message`/`setupComplete` as actual JSON keys.
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
   * True only for the addon's `KEMFAI_<CODE>: ...`-prefixed `ValidationError` messages,
   * all raised by `models/company.py` (245-443) BEFORE the row lock / mutation commit.
   * Anything else (transport failure, lost response, unrecognized shape) is ambiguous —
   * see `runOdooUpdate`'s catch block (B1).
   */
  private isKnownOdooFault(message: string): boolean {
    return (
      message.includes('KEMFAI_SETUP_INCOMPLETE') ||
      message.includes('KEMFAI_CONFIG_GAP') ||
      message.includes('KEMFAI_VAT_FORMAT') ||
      message.includes('KEMFAI_REQUIRED_FIELD') ||
      message.includes('KEMFAI_INVALID_COUNTRY') ||
      message.includes('KEMFAI_INVALID_CURRENCY') ||
      message.includes('KEMFAI_INVALID_INDUSTRY') ||
      message.includes('KEMFAI_INVALID_PAYLOAD')
    );
  }

  private translateFault(message: string): never {
    if (message.includes('KEMFAI_SETUP_INCOMPLETE')) {
      throw new ConflictException({
        statusCode: 409,
        message: stripKemfaiPrefix(message),
        setupComplete: false,
      });
    }
    if (message.includes('KEMFAI_CONFIG_GAP')) {
      throw new ConflictException('No VAT/tax validation rule is configured for this country');
    }
    if (
      message.includes('KEMFAI_VAT_FORMAT') ||
      message.includes('KEMFAI_REQUIRED_FIELD') ||
      message.includes('KEMFAI_INVALID_COUNTRY') ||
      message.includes('KEMFAI_INVALID_CURRENCY') ||
      message.includes('KEMFAI_INVALID_INDUSTRY') ||
      message.includes('KEMFAI_INVALID_PAYLOAD')
    ) {
      throw new UnprocessableEntityException(stripKemfaiPrefix(message));
    }
    // Never pass through a raw Odoo/RPC error: it can contain internal detail.
    throw new InternalServerErrorException('Company settings are temporarily unavailable');
  }

  private toDto(result: unknown): CompanySettingsViewDto {
    const view = result as OdooCompanySettingsView;
    return {
      values: view.values,
      setupComplete: view.setupComplete,
    };
  }
}
