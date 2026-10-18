import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import controlDataSource from '../../database/data-source';
import { AuditActorType, AuditEvent } from './entities/audit-event.entity';

export interface AuditEventInput {
  actorType: AuditActorType;
  actorId: string | null;
  tenantId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  /**
   * T055 remediation — set this to make the write "ensure this event exists exactly
   * once" (DB-enforced via `uq_audit_event_dedupe_key`) instead of "append another row".
   * Omit for every pre-existing action; those still always insert a new row.
   */
  dedupeKey?: string;
}

export interface AccountCreatedInput {
  accountId: string;
  planId: string;
  billingCycle: string;
  occurredAt?: Date;
}

export interface AccountLocaleChangedInput {
  accountId: string;
  fromLocale: string | null;
  toLocale: string;
  occurredAt?: Date;
}

export interface AccountEmailVerifiedInput {
  accountId: string;
  occurredAt?: Date;
}

export interface AccountMfaEnrolledInput {
  accountId: string;
  tenantId: string | null;
  occurredAt?: Date;
}

export interface TenantProvisioningAttemptedInput {
  tenantId: string;
  attemptNumber: number;
  occurredAt?: Date;
}

export interface TenantProvisioningSucceededInput {
  tenantId: string;
  odooDbName: string;
  occurredAt?: Date;
}

export interface TenantProvisioningFailedInput {
  tenantId: string;
  failureReason: string;
  occurredAt?: Date;
}

export interface CompanySetupCompletedInput {
  accountId: string;
  tenantId: string;
  companyId: string;
  /** T055 remediation (Finding 4) — the actual Odoo tenant DB + res.company.id this
   *  completion event is about, since `companyId` above is the control plane's tenant
   *  UUID (there is no separate UUID "Company" entity — see the call site's comment). */
  odooDbName: string;
  odooCompanyId: number;
  occurredAt?: Date;
  /** T055 durable-handoff remediation — the `company_mutation_handoff.id` (the
   *  immutable operation UUID) this completion is for. When present it REPLACES the
   *  old per-tenant dedupe key: dedupe is now anchored to the single stable completion
   *  handoff (one per tenant, see `CompanyMutationHandoffService`), not recomputed per
   *  call, so every retry/recovery attempt for the SAME completion converges on it. */
  operationUuid?: string;
}

export interface CompanySettingsUpdatedInput {
  accountId: string;
  tenantId: string;
  companyId: string;
  odooDbName: string;
  odooCompanyId: number;
  changedFields: string[];
  /** T055 remediation (Finding 3) — present only when the caller sent an
   *  `Idempotency-Key` header; used to build this event's `dedupeKey` so a
   *  lost-response/failed-audit retry of the SAME logical edit never appends twice.
   *  Superseded by `operationUuid` when present (see below). */
  idempotencyKey?: string;
  occurredAt?: Date;
  /** T055 durable-handoff remediation — the `company_mutation_handoff.id` for this
   *  settings edit. When present it REPLACES the raw tenant+client-key dedupe anchor:
   *  dedupe is anchored to the operation UUID itself, which already resolves the same
   *  key-scope identically (and never collapses two distinct authorized callers who
   *  happen to reuse the same textual key, since the handoff's uniqueness is scoped by
   *  authenticated-caller+tenant+method+route+key, not the raw key string). */
  operationUuid?: string;
}

export interface ModulesSelectionChangedInput {
  accountId: string;
  tenantId: string;
  moduleSelectionId: string;
  added: string[];
  removed: string[];
  occurredAt?: Date;
  operationUuid?: string;
}

export interface BillingPaymentSubmissionCreatedInput {
  accountId: string;
  tenantId: string;
  paymentSubmissionId: string;
  bankReference: string;
  amount: string;
  currency: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  occurredAt?: Date;
}

export type BillingDecision = 'approve' | 'reject' | 'more_info';

export interface BillingActivationAuditFields {
  customer: string;
  tenant: string;
  plan: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  amount: string;
  currency: string;
  bankReference: string;
  proofDocumentReference: string;
  reviewedBy: string;
  reviewedAt: Date;
  decision: BillingDecision;
  /**
   * T070 — null when the decision did not activate (reject / more_info): no activation
   * happened, and the FR-009 payload records that truthfully instead of fabricating an
   * activation identity/timestamp. Approvals (T069) always pass real values.
   */
  activatedBy: string | null;
  activatedAt: Date | null;
  notes: string | null;
  statusHistory: unknown[];
}

export interface BillingPaymentSubmissionDecidedInput extends BillingActivationAuditFields {
  reviewerInternalUserId: string;
  tenantId: string;
  paymentSubmissionId: string;
  occurredAt?: Date;
}

export interface BillingSubscriptionActivatedInput extends BillingActivationAuditFields {
  activatedByInternalUserId: string;
  tenantId: string;
  subscriptionId: string;
  occurredAt?: Date;
}

export interface SupportAccessGrantCreatedInput {
  accountId: string;
  tenantId: string;
  grantId: string;
  granteeRole: string;
  expiresAt: Date;
  occurredAt?: Date;
}

export interface SupportAccessGrantUsedInput {
  internalUserId: string;
  tenantId: string;
  grantId: string;
  actionSummary: string;
  occurredAt?: Date;
}

export interface SupportAccessGrantDeniedInput {
  internalUserId: string;
  tenantId: string | null;
  grantId: string;
  denialReason: string;
  occurredAt?: Date;
}

export interface SupportAccessGrantRevokedInput {
  accountId: string;
  tenantId: string;
  grantId: string;
  revokedBy: string;
  occurredAt?: Date;
}

export interface SupportAccessGrantExpiredInput {
  tenantId: string;
  grantId: string;
  occurredAt?: Date;
}

export interface TenantTrialRestrictedInput {
  tenantId: string;
  trialWindowDays: number;
  elapsedDays: number;
  autoRestrictUnpaid: boolean;
  occurredAt?: Date;
}

export interface TenantAccessDeniedCrossTenantInput {
  actorType: AuditActorType.ACCOUNT | AuditActorType.INTERNAL_USER;
  actorId: string | null;
  requestingTenantId: string | null;
  resourceType: string;
  resourceId: string;
  targetTenantId: string | null;
  resourcePath: string;
  occurredAt?: Date;
}

/**
 * Append-only audit writer covering the full FR-007 event catalog (contracts/events.md).
 * `append` is the single low-level write path — enforced immutable at the Postgres privilege
 * level by the T014 migration, never by application convention — and every `record*` method
 * below is a thin, exactly-typed wrapper over it, one per catalog row, so a call site can
 * never misspell an action string or omit a payload field the catalog requires. This is the
 * only file that may construct an `action` string from the catalog (T019 acceptance
 * criterion): future call sites (T032 signup, T044 provisioning, etc.) call these methods,
 * never `append` directly, for the 19 actions modeled here.
 */
@Injectable()
export class AuditService {
  private async appendInContext(event: AuditEventInput, manager?: EntityManager): Promise<void> {
    if (manager) await this.append(event, manager);
    else await this.append(event);
  }
  /**
   * `manager` lets a caller enlist this write in an already-open DB transaction (T035:
   * MFA confirmation's state flip and its mandatory audit event must commit or roll back
   * together — see mfa.service.ts) instead of always opening its own connection via
   * `controlDataSource`. Every other call site omits it and behaves exactly as before.
   */
  async append(event: AuditEventInput, manager?: EntityManager): Promise<void> {
    const repo = (manager ?? controlDataSource).getRepository(AuditEvent);
    const row = {
      actorType: event.actorType,
      actorId: event.actorId,
      tenantId: event.tenantId,
      action: event.action,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      occurredAt: event.occurredAt,
      payload: event.payload,
      dedupeKey: event.dedupeKey ?? null,
      createdAt: new Date(),
    } as QueryDeepPartialEntity<AuditEvent>;

    if (event.dedupeKey) {
      // `orIgnore()` compiles to `ON CONFLICT DO NOTHING` — the DB-enforced "ensure this
      // event exists exactly once" path (`uq_audit_event_dedupe_key`). It needs only
      // INSERT privilege (no row is ever modified on conflict), so it works under the
      // same T014-revoked UPDATE/DELETE grant every other write here already respects.
      await repo.createQueryBuilder().insert().values(row).orIgnore().execute();
      return;
    }
    await repo.insert(row);
  }

  async recordAccountCreated(input: AccountCreatedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.ACCOUNT,
      actorId: input.accountId,
      tenantId: null,
      action: 'account.created',
      subjectType: 'account',
      subjectId: input.accountId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { plan_id: input.planId, billing_cycle: input.billingCycle },
    });
  }

  async recordAccountEmailVerified(input: AccountEmailVerifiedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.ACCOUNT,
      actorId: input.accountId,
      tenantId: null,
      action: 'account.email_verified',
      subjectType: 'account',
      subjectId: input.accountId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: {},
    });
  }

  /**
   * T104 — `account.locale_changed`: the account holder changed their persisted UI
   * locale preference (FR-024). Control-plane scope (tenantId null — the preference
   * belongs to the account, pre-tenant). Payload records old→new for traceability.
   */
  async recordAccountLocaleChanged(
    input: AccountLocaleChangedInput,
    manager?: EntityManager,
  ): Promise<void> {
    await this.appendInContext(
      {
        actorType: AuditActorType.ACCOUNT,
        actorId: input.accountId,
        tenantId: null,
        action: 'account.locale_changed',
        subjectType: 'account',
        subjectId: input.accountId,
        occurredAt: input.occurredAt ?? new Date(),
        payload: { from_locale: input.fromLocale, to_locale: input.toLocale },
      },
      manager,
    );
  }

  async recordAccountMfaEnrolled(
    input: AccountMfaEnrolledInput,
    manager?: EntityManager,
  ): Promise<void> {
    const event: AuditEventInput = {
      actorType: AuditActorType.ACCOUNT,
      actorId: input.accountId,
      tenantId: input.tenantId,
      action: 'account.mfa_enrolled',
      subjectType: 'account',
      subjectId: input.accountId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: {},
    };
    // Only forward a second argument when a caller actually supplies a transaction
    // manager (T035) — an explicit `undefined` second arg would still show up in a
    // `toHaveBeenCalledWith(oneArgMatcher)` assertion's call-arity check, breaking every
    // OTHER record* method's existing single-argument `append` expectation.
    if (manager) {
      await this.append(event, manager);
    } else {
      await this.append(event);
    }
  }

  async recordTenantProvisioningAttempted(
    input: TenantProvisioningAttemptedInput,
    manager?: EntityManager,
  ): Promise<void> {
    const event: AuditEventInput = {
      actorType: AuditActorType.SYSTEM,
      actorId: null,
      tenantId: input.tenantId,
      action: 'tenant.provisioning.attempted',
      subjectType: 'tenant',
      subjectId: input.tenantId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { attempt_number: input.attemptNumber },
    };
    if (manager) await this.append(event, manager);
    else await this.append(event);
  }

  async recordTenantProvisioningSucceeded(
    input: TenantProvisioningSucceededInput,
    manager?: EntityManager,
  ): Promise<void> {
    const event: AuditEventInput = {
      actorType: AuditActorType.SYSTEM,
      actorId: null,
      tenantId: input.tenantId,
      action: 'tenant.provisioning.succeeded',
      subjectType: 'tenant',
      subjectId: input.tenantId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { odoo_db_name: input.odooDbName },
    };
    if (manager) await this.append(event, manager);
    else await this.append(event);
  }

  async recordTenantProvisioningFailed(
    input: TenantProvisioningFailedInput,
    manager?: EntityManager,
  ): Promise<void> {
    const event: AuditEventInput = {
      actorType: AuditActorType.SYSTEM,
      actorId: null,
      tenantId: input.tenantId,
      action: 'tenant.provisioning.failed',
      subjectType: 'tenant',
      subjectId: input.tenantId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { failure_reason: input.failureReason },
    };
    if (manager) await this.append(event, manager);
    else await this.append(event);
  }

  /**
   * T055 remediation (Finding 1) — `dedupeKey` is `company.setup.completed:<tenantId>`:
   * a given tenant can only ever complete setup once, so this is "ensure the single
   * completion event for this tenant exists" rather than "append another row". The
   * caller (`CompanySetupService.completeSetup`) calls this on EVERY `kemfai_setup_complete`
   * response — including `alreadyComplete: true` ones — so a retry after an audit-store
   * failure, a lost Odoo RPC response, or a crash between the Odoo commit and this write
   * all converge on the same outcome: exactly one durable row, written by whichever
   * attempt (the original or a later retry) actually reaches this method successfully.
   * `uq_audit_event_dedupe_key` is what makes concurrent attempts safe: at most one
   * `INSERT` wins, every other one is a silent, harmless no-op.
   */
  async recordCompanySetupCompleted(input: CompanySetupCompletedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.ACCOUNT,
      actorId: input.accountId,
      tenantId: input.tenantId,
      action: 'company.setup.completed',
      subjectType: 'company',
      subjectId: input.companyId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { odoo_db_name: input.odooDbName, odoo_company_id: input.odooCompanyId },
      dedupeKey: input.operationUuid
        ? `company.setup.completed:${input.operationUuid}`
        : `company.setup.completed:${input.tenantId}`,
    });
  }

  /**
   * T055 remediation (Finding 3) — when the caller supplies `idempotencyKey` (read from
   * the request's `Idempotency-Key` header, the project's existing retry-identity
   * convention — see `IdempotencyKeyInterceptor`), this write is anchored on
   * `company.settings.updated:<tenantId>:<idempotencyKey>`: a retry of the SAME logical
   * edit (after a failed append, or after a successful one whose HTTP response was lost)
   * converges on exactly one row instead of appending a duplicate. Without a client-
   * supplied key there is no way to distinguish "the same logical edit retried" from
   * "a genuinely new edit with the same values" — that call then has no dedupe anchor
   * and append behaves as a normal, unconstrained append (unchanged from before this
   * remediation), exactly like every other call site that passes no `dedupeKey`.
   */
  async recordCompanySettingsUpdated(input: CompanySettingsUpdatedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.ACCOUNT,
      actorId: input.accountId,
      tenantId: input.tenantId,
      action: 'company.settings.updated',
      subjectType: 'company',
      subjectId: input.companyId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: {
        changed_fields: input.changedFields,
        odoo_db_name: input.odooDbName,
        odoo_company_id: input.odooCompanyId,
      },
      dedupeKey: input.operationUuid
        ? `company.settings.updated:${input.operationUuid}`
        : input.idempotencyKey
          ? `company.settings.updated:${input.tenantId}:${input.idempotencyKey}`
          : undefined,
    });
  }

  async recordModulesSelectionChanged(input: ModulesSelectionChangedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.ACCOUNT,
      actorId: input.accountId,
      tenantId: input.tenantId,
      action: 'modules.selection.changed',
      subjectType: 'module_selection',
      subjectId: input.moduleSelectionId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { added: input.added, removed: input.removed },
      dedupeKey: input.operationUuid
        ? `modules.selection.changed:${input.operationUuid}`
        : undefined,
    });
  }

  async recordBillingPaymentSubmissionCreated(
    input: BillingPaymentSubmissionCreatedInput,
    manager?: EntityManager,
  ): Promise<void> {
    const event: AuditEventInput = {
      actorType: AuditActorType.ACCOUNT,
      actorId: input.accountId,
      tenantId: input.tenantId,
      action: 'billing.payment_submission.created',
      subjectType: 'payment_submission',
      subjectId: input.paymentSubmissionId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: {
        bank_reference: input.bankReference,
        amount: input.amount,
        currency: input.currency,
        billing_period: { start: input.billingPeriodStart, end: input.billingPeriodEnd },
      },
    };
    if (manager) await this.append(event, manager);
    else await this.append(event);
  }

  async recordBillingPaymentSubmissionDecided(
    input: BillingPaymentSubmissionDecidedInput,
    manager?: EntityManager,
  ): Promise<void> {
    const event: AuditEventInput = {
      actorType: AuditActorType.INTERNAL_USER,
      actorId: input.reviewerInternalUserId,
      tenantId: input.tenantId,
      action: 'billing.payment_submission.decided',
      subjectType: 'payment_submission',
      subjectId: input.paymentSubmissionId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: billingActivationPayload(input),
    };
    if (manager) await this.append(event, manager);
    else await this.append(event);
  }

  async recordBillingSubscriptionActivated(
    input: BillingSubscriptionActivatedInput,
    manager?: EntityManager,
  ): Promise<void> {
    const event: AuditEventInput = {
      actorType: AuditActorType.INTERNAL_USER,
      actorId: input.activatedByInternalUserId,
      tenantId: input.tenantId,
      action: 'billing.subscription.activated',
      subjectType: 'subscription',
      subjectId: input.subscriptionId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: billingActivationPayload(input),
    };
    if (manager) await this.append(event, manager);
    else await this.append(event);
  }

  async recordSupportAccessGrantCreated(
    input: SupportAccessGrantCreatedInput,
    manager?: EntityManager,
  ): Promise<void> {
    await this.appendInContext(
      {
        actorType: AuditActorType.ACCOUNT,
        actorId: input.accountId,
        tenantId: input.tenantId,
        action: 'support_access.grant.created',
        subjectType: 'support_access_grant',
        subjectId: input.grantId,
        occurredAt: input.occurredAt ?? new Date(),
        payload: { grantee_role: input.granteeRole, expires_at: input.expiresAt.toISOString() },
      },
      manager,
    );
  }

  async recordSupportAccessGrantUsed(
    input: SupportAccessGrantUsedInput,
    manager?: EntityManager,
  ): Promise<void> {
    await this.appendInContext(
      {
        actorType: AuditActorType.INTERNAL_USER,
        actorId: input.internalUserId,
        tenantId: input.tenantId,
        action: 'support_access.grant.used',
        subjectType: 'support_access_grant',
        subjectId: input.grantId,
        occurredAt: input.occurredAt ?? new Date(),
        payload: { action_summary: input.actionSummary },
      },
      manager,
    );
  }

  async recordSupportAccessGrantDenied(
    input: SupportAccessGrantDeniedInput,
    manager?: EntityManager,
  ): Promise<void> {
    await this.appendInContext(
      {
        actorType: AuditActorType.INTERNAL_USER,
        actorId: input.internalUserId,
        tenantId: input.tenantId,
        action: 'support_access.grant.denied',
        subjectType: 'support_access_grant',
        subjectId: input.grantId,
        occurredAt: input.occurredAt ?? new Date(),
        payload: { denial_reason: input.denialReason },
      },
      manager,
    );
  }

  async recordSupportAccessGrantRevoked(
    input: SupportAccessGrantRevokedInput,
    manager?: EntityManager,
  ): Promise<void> {
    await this.appendInContext(
      {
        actorType: AuditActorType.ACCOUNT,
        actorId: input.accountId,
        tenantId: input.tenantId,
        action: 'support_access.grant.revoked',
        subjectType: 'support_access_grant',
        subjectId: input.grantId,
        occurredAt: input.occurredAt ?? new Date(),
        payload: { revoked_by: input.revokedBy },
      },
      manager,
    );
  }

  async recordSupportAccessGrantExpired(
    input: SupportAccessGrantExpiredInput,
    manager?: EntityManager,
  ): Promise<void> {
    await this.appendInContext(
      {
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        tenantId: input.tenantId,
        action: 'support_access.grant.expired',
        subjectType: 'support_access_grant',
        subjectId: input.grantId,
        occurredAt: input.occurredAt ?? new Date(),
        payload: {},
        dedupeKey: `support-access-expired:${input.grantId}`,
      },
      manager,
    );
  }

  async recordTenantTrialRestricted(input: TenantTrialRestrictedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.SYSTEM,
      actorId: null,
      tenantId: input.tenantId,
      action: 'tenant.trial.restricted',
      subjectType: 'tenant',
      subjectId: input.tenantId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: {
        trial_window_days: input.trialWindowDays,
        elapsed_days: input.elapsedDays,
        auto_restrict_unpaid: input.autoRestrictUnpaid,
      },
    });
  }

  async recordTenantAccessDeniedCrossTenant(
    input: TenantAccessDeniedCrossTenantInput,
  ): Promise<void> {
    await this.append({
      actorType: input.actorType,
      actorId: input.actorId,
      tenantId: input.requestingTenantId,
      action: 'tenant_access.denied_cross_tenant',
      subjectType: input.resourceType,
      subjectId: input.resourceId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: {
        target_tenant_id: input.targetTenantId,
        resource_path: input.resourcePath,
      },
    });
  }
}

function billingActivationPayload(input: BillingActivationAuditFields): Record<string, unknown> {
  return {
    customer: input.customer,
    tenant: input.tenant,
    plan: input.plan,
    billing_period: { start: input.billingPeriodStart, end: input.billingPeriodEnd },
    amount: input.amount,
    currency: input.currency,
    bank_reference: input.bankReference,
    proof_document_reference: input.proofDocumentReference,
    decision: input.decision,
    reviewed_by: input.reviewedBy,
    reviewed_at: input.reviewedAt.toISOString(),
    activation_decision: input.decision,
    activated_by: input.activatedBy,
    activated_at: input.activatedAt ? input.activatedAt.toISOString() : null,
    notes: input.notes,
    status_history: input.statusHistory,
  };
}
