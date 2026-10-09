import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  PreconditionFailedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  TenantContext,
  TenantScopedRequest,
} from '../../common/tenant-context/tenant-context.model';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { AuditService } from '../audit/audit.service';
import { CompanyOdooContextService } from './company-odoo-context.service';
import {
  CompanyMutationHandoffRow,
  CompanyMutationHandoffService,
} from './company-mutation-handoff.service';
import { CompanyMutationHandoffState } from './entities/company-mutation-handoff.entity';
import { computeCompanySetupScope } from './company-setup-scope.util';
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

export interface OdooCompanySetupCompleteResult extends OdooCompanySetupState {
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
    // T056 round-5 binding resolution (items 1+2) — tenant/principal resolution and the
    // control-plane-only company-target lookup both happen BEFORE `resolveCredentials`,
    // which is the first call in this method allowed to touch Odoo (`authenticate`).
    const tenantContext = await this.context.resolveTenantContext(req);
    this.assertResolvedPrincipal(tenantContext);
    const companyId = await this.context.resolveCompanyTarget(tenantContext.callerTenantId);
    const { db, uid, password } = await this.context.resolveCredentials(
      tenantContext.callerTenantId,
    );
    const result = await this.callOrTranslate(() =>
      this.odoo.executeKw(db, uid, password, 'res.company', 'kemfai_setup_get_state', [
        [companyId],
      ]),
    );
    return this.toDto(result, tenantContext, companyId);
  }

  async saveStep(
    req: TenantScopedRequest,
    body: CompanySetupStepRequestDto,
    clientScope?: string,
  ): Promise<CompanySetupStateDto> {
    // T056 round-5 binding resolution (item 1) — the scope precondition is evaluated
    // against a company id resolved purely from the control plane, and is checked BEFORE
    // `resolveCredentials` (the first Odoo-facing call in this method): a missing, blank,
    // or stale scope now causes ZERO Odoo RPCs of any kind, not merely zero mutation RPCs.
    const tenantContext = await this.context.resolveTenantContext(req);
    this.assertResolvedPrincipal(tenantContext);
    const companyId = await this.context.resolveCompanyTarget(tenantContext.callerTenantId);
    this.assertScopePrecondition(tenantContext, companyId, clientScope);
    const { db, uid, password } = await this.context.resolveCredentials(
      tenantContext.callerTenantId,
    );
    const result = await this.callOrTranslate(() =>
      this.odoo.executeKw(db, uid, password, 'res.company', 'kemfai_setup_save_step', [
        [companyId],
        body.step,
        body.values,
        body.baseVersion ?? null,
      ]),
    );
    return this.toDto(result, tenantContext, companyId);
  }

  /**
   * T056 round-5 binding resolution (item 2) — ONE shared nonblank principal validator for
   * every operation (GET/PUT/completion), covering `accountId`, `callerTenantId`, AND
   * `keycloakUserId` uniformly: a token that somehow resolves without any one of them must
   * fail closed, before any Odoo-facing resolution (`resolveCompanyTarget`/
   * `resolveCredentials`) and before `toDto` could hash a missing identity component (`''`)
   * into the opaque scope. `.trim()` matters: a whitespace-only identity component is not a
   * real identity and must not be treated as one. `keycloakUserId` is validated here even
   * for GET/PUT (which do not themselves consume it) so every operation fails closed on an
   * incomplete principal identically — completion is no longer the only path that checks it.
   */
  private assertResolvedPrincipal(
    tenantContext: TenantContext,
  ): asserts tenantContext is TenantContext & {
    accountId: string;
    callerTenantId: string;
    keycloakUserId: string;
  } {
    if (
      !tenantContext.accountId?.trim() ||
      !tenantContext.callerTenantId?.trim() ||
      !tenantContext.keycloakUserId?.trim()
    ) {
      throw new InternalServerErrorException(
        'No account/tenant/principal resolved for this request',
      );
    }
  }

  /**
   * T056 round-3 binding resolution — `X-KEMFAI-Setup-Scope` is REQUIRED on every PUT and
   * completion POST, including a session's very first mutation. There is no "first save,
   * nothing to echo yet" exception: the client always has a scope available because it
   * must perform a GET before it can render the form the mutation came from, and any
   * caller skipping that GET is exactly the case this precondition exists to close — a
   * missing/blank header is rejected with 412 BEFORE any Odoo RPC or handoff creation,
   * identically to a mismatched one.
   */
  private assertScopePrecondition(
    tenantContext: TenantContext & { accountId: string; callerTenantId: string },
    companyId: number,
    clientScope: string | undefined,
  ): void {
    if (!clientScope?.trim()) {
      throw new PreconditionFailedException('X-KEMFAI-Setup-Scope header is required');
    }
    const expected = computeCompanySetupScope(
      tenantContext.callerTenantId,
      tenantContext.accountId,
      companyId,
    );
    if (clientScope !== expected) {
      throw new PreconditionFailedException(
        'Setup scope no longer matches the authenticated company',
      );
    }
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
  async completeSetup(
    req: TenantScopedRequest,
    clientScope?: string,
  ): Promise<CompanySetupStateDto> {
    // T056 round-5 binding resolution (items 1+2) — identical ordering to saveStep:
    // principal validation and the control-plane-only company-target lookup both happen
    // before the scope precondition, which in turn happens before `resolveCredentials`
    // (the first Odoo-facing call in this method) and before the handoff is created.
    const tenantContext = await this.context.resolveTenantContext(req);
    this.assertResolvedPrincipal(tenantContext);
    const companyId = await this.context.resolveCompanyTarget(tenantContext.callerTenantId);
    this.assertScopePrecondition(tenantContext, companyId, clientScope);
    const { db, uid, password } = await this.context.resolveCredentials(
      tenantContext.callerTenantId,
    );

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
      // Round-3 binding resolution point 2 — validate the STORED payload before it is
      // ever returned; a corrupted/malformed `finalResponse` row must become a generic
      // 5xx here, not a malformed 200 (there is no further durable action to guard in
      // this branch — it is already audited — but the response itself must still fail
      // closed rather than trust a stored blob unconditionally).
      CompanySetupService.assertValidCompletionResult(handoff.finalResponse);
      return this.toDto(handoff.finalResponse, tenantContext, companyId);
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

    return this.toDto(result, tenantContext, companyId);
  }

  private async runOdooCompletion(
    handoff: CompanyMutationHandoffRow,
    db: string,
    uid: number,
    password: string,
    companyId: number,
  ): Promise<OdooCompanySetupCompleteResult> {
    if (handoff.state === CompanyMutationHandoffState.ODOO_COMMITTED) {
      // Round-3 binding resolution point 2 — validate the STORED payload before it is
      // trusted for the audit append/markAudited that is about to follow in the caller.
      // A malformed row here must fail closed (5xx), never advance to AUDITED.
      CompanySetupService.assertValidCompletionResult(handoff.finalResponse);
      return handoff.finalResponse;
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

    // Round-3 binding resolution point 2 — validate the FRESH Odoo result BEFORE
    // `markOdooCommitted` persists it (and before the caller's audit append runs on it).
    // A malformed fresh result is treated exactly like the ambiguous-failure branch
    // above: Odoo may or may not actually have committed something usable, so the
    // handoff is left retryable (never deleted, never marked committed with garbage)
    // for CompanyMutationRecoveryWorker to resolve via receipt replay, and the caller
    // gets a generic 5xx rather than ever seeing this result.
    try {
      CompanySetupService.assertValidCompletionResult(result);
    } catch (validationError) {
      await this.handoffs.scheduleRetryBackoff(handoff.id, 0);
      throw validationError;
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

  /**
   * T056 binding-review point 5 — `result` originates from the Odoo RPC response or a
   * stored handoff's `finalResponse`, neither of which is this service's own typed
   * output: a malformed shape there (bad upgrade, corrupted handoff row, unexpected addon
   * change) must never be cast and handed to a caller as a trusted 2xx. Fail closed with
   * a generic 5xx instead of leaking a malformed body.
   */
  private static readonly KNOWN_STEPS = new Set([
    'country',
    'identity',
    'currency',
    'fiscal_year',
    'vat_tax',
    'industry',
    'accounting_setup',
  ]);

  /**
   * Static (and exported-class-reusable) so `CompanyMutationRecoveryWorker` validates a
   * SETUP_COMPLETE result with this EXACT same check — round-3 binding resolution point
   * 2 — rather than forking a second, possibly-drifting copy of "what counts as a
   * well-formed Odoo setup-state payload".
   */
  static assertValidUpstreamState(result: unknown): asserts result is OdooCompanySetupState {
    const state = result as Partial<OdooCompanySetupState> | null | undefined;
    const valid =
      !!state &&
      typeof state === 'object' &&
      typeof state.currentStep === 'string' &&
      CompanySetupService.KNOWN_STEPS.has(state.currentStep) &&
      typeof state.setupComplete === 'boolean' &&
      typeof state.values === 'object' &&
      state.values !== null &&
      !Array.isArray(state.values) &&
      typeof state.version === 'number' &&
      Number.isInteger(state.version) &&
      state.version >= 0 &&
      typeof state.stale === 'boolean';
    if (!valid) {
      throw new InternalServerErrorException('Company setup is temporarily unavailable');
    }
  }

  /**
   * Round-3 binding resolution point 2 — completion results carry one more field
   * (`alreadyComplete`) that the base setup-state shape does not; a result missing it or
   * carrying a non-boolean must fail exactly like any other malformed shape, BEFORE
   * `markOdooCommitted`/audit append/`markAudited` ever runs on it; the base checks above
   * aren't enough for a completion-specific result on their own.
   */
  static assertValidCompletionResult(
    result: unknown,
  ): asserts result is OdooCompanySetupCompleteResult {
    CompanySetupService.assertValidUpstreamState(result);
    if (typeof (result as OdooCompanySetupCompleteResult).alreadyComplete !== 'boolean') {
      throw new InternalServerErrorException('Company setup is temporarily unavailable');
    }
  }

  private toDto(
    result: unknown,
    tenantContext: TenantContext & { accountId: string; callerTenantId: string },
    companyId: number,
  ): CompanySetupStateDto {
    CompanySetupService.assertValidUpstreamState(result);
    const state = result;
    return {
      currentStep: state.currentStep,
      setupComplete: state.setupComplete,
      values: state.values,
      version: state.version,
      stale: state.stale,
      scope: computeCompanySetupScope(
        tenantContext.callerTenantId,
        tenantContext.accountId,
        companyId,
      ),
    };
  }
}
