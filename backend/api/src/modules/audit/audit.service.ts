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
  occurredAt?: Date;
}

export interface CompanySettingsUpdatedInput {
  accountId: string;
  tenantId: string;
  companyId: string;
  changedFields: string[];
  occurredAt?: Date;
}

export interface ModulesSelectionChangedInput {
  accountId: string;
  tenantId: string;
  moduleSelectionId: string;
  added: string[];
  removed: string[];
  occurredAt?: Date;
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

export interface BillingPaymentSubmissionDecidedInput {
  reviewerInternalUserId: string;
  tenantId: string;
  paymentSubmissionId: string;
  decision: BillingDecision;
  reviewedAt: Date;
  notes: string | null;
  occurredAt?: Date;
}

export interface BillingSubscriptionActivatedInput {
  activatedByInternalUserId: string;
  tenantId: string;
  subscriptionId: string;
  activatedAt: Date;
  billingPeriodStart: string;
  billingPeriodEnd: string;
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
  tenantId: string;
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
  /**
   * `manager` lets a caller enlist this write in an already-open DB transaction (T035:
   * MFA confirmation's state flip and its mandatory audit event must commit or roll back
   * together — see mfa.service.ts) instead of always opening its own connection via
   * `controlDataSource`. Every other call site omits it and behaves exactly as before.
   */
  async append(event: AuditEventInput, manager?: EntityManager): Promise<void> {
    const repo = (manager ?? controlDataSource).getRepository(AuditEvent);
    await repo.insert({
      actorType: event.actorType,
      actorId: event.actorId,
      tenantId: event.tenantId,
      action: event.action,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      occurredAt: event.occurredAt,
      payload: event.payload,
      createdAt: new Date(),
    } as QueryDeepPartialEntity<AuditEvent>);
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
    await this.append({
      actorType: AuditActorType.ACCOUNT,
      actorId: input.accountId,
      tenantId: null,
      action: 'account.locale_changed',
      subjectType: 'account',
      subjectId: input.accountId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { from_locale: input.fromLocale, to_locale: input.toLocale },
    }, manager);
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

  async recordTenantProvisioningAttempted(input: TenantProvisioningAttemptedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.SYSTEM,
      actorId: null,
      tenantId: input.tenantId,
      action: 'tenant.provisioning.attempted',
      subjectType: 'tenant',
      subjectId: input.tenantId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { attempt_number: input.attemptNumber },
    });
  }

  async recordTenantProvisioningSucceeded(input: TenantProvisioningSucceededInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.SYSTEM,
      actorId: null,
      tenantId: input.tenantId,
      action: 'tenant.provisioning.succeeded',
      subjectType: 'tenant',
      subjectId: input.tenantId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { odoo_db_name: input.odooDbName },
    });
  }

  async recordTenantProvisioningFailed(input: TenantProvisioningFailedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.SYSTEM,
      actorId: null,
      tenantId: input.tenantId,
      action: 'tenant.provisioning.failed',
      subjectType: 'tenant',
      subjectId: input.tenantId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { failure_reason: input.failureReason },
    });
  }

  async recordCompanySetupCompleted(input: CompanySetupCompletedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.ACCOUNT,
      actorId: input.accountId,
      tenantId: input.tenantId,
      action: 'company.setup.completed',
      subjectType: 'company',
      subjectId: input.companyId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: {},
    });
  }

  async recordCompanySettingsUpdated(input: CompanySettingsUpdatedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.ACCOUNT,
      actorId: input.accountId,
      tenantId: input.tenantId,
      action: 'company.settings.updated',
      subjectType: 'company',
      subjectId: input.companyId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { changed_fields: input.changedFields },
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
    });
  }

  async recordBillingPaymentSubmissionCreated(
    input: BillingPaymentSubmissionCreatedInput,
  ): Promise<void> {
    await this.append({
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
    });
  }

  async recordBillingPaymentSubmissionDecided(
    input: BillingPaymentSubmissionDecidedInput,
  ): Promise<void> {
    await this.append({
      actorType: AuditActorType.INTERNAL_USER,
      actorId: input.reviewerInternalUserId,
      tenantId: input.tenantId,
      action: 'billing.payment_submission.decided',
      subjectType: 'payment_submission',
      subjectId: input.paymentSubmissionId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: {
        decision: input.decision,
        reviewed_by: input.reviewerInternalUserId,
        reviewed_at: input.reviewedAt.toISOString(),
        notes: input.notes,
      },
    });
  }

  async recordBillingSubscriptionActivated(
    input: BillingSubscriptionActivatedInput,
  ): Promise<void> {
    await this.append({
      actorType: AuditActorType.INTERNAL_USER,
      actorId: input.activatedByInternalUserId,
      tenantId: input.tenantId,
      action: 'billing.subscription.activated',
      subjectType: 'subscription',
      subjectId: input.subscriptionId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: {
        activated_by: input.activatedByInternalUserId,
        activated_at: input.activatedAt.toISOString(),
        billing_period: { start: input.billingPeriodStart, end: input.billingPeriodEnd },
      },
    });
  }

  async recordSupportAccessGrantCreated(input: SupportAccessGrantCreatedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.ACCOUNT,
      actorId: input.accountId,
      tenantId: input.tenantId,
      action: 'support_access.grant.created',
      subjectType: 'support_access_grant',
      subjectId: input.grantId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { grantee_role: input.granteeRole, expires_at: input.expiresAt.toISOString() },
    });
  }

  async recordSupportAccessGrantUsed(input: SupportAccessGrantUsedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.INTERNAL_USER,
      actorId: input.internalUserId,
      tenantId: input.tenantId,
      action: 'support_access.grant.used',
      subjectType: 'support_access_grant',
      subjectId: input.grantId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { action_summary: input.actionSummary },
    });
  }

  async recordSupportAccessGrantDenied(input: SupportAccessGrantDeniedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.INTERNAL_USER,
      actorId: input.internalUserId,
      tenantId: input.tenantId,
      action: 'support_access.grant.denied',
      subjectType: 'support_access_grant',
      subjectId: input.grantId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { denial_reason: input.denialReason },
    });
  }

  async recordSupportAccessGrantRevoked(input: SupportAccessGrantRevokedInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.ACCOUNT,
      actorId: input.accountId,
      tenantId: input.tenantId,
      action: 'support_access.grant.revoked',
      subjectType: 'support_access_grant',
      subjectId: input.grantId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: { revoked_by: input.revokedBy },
    });
  }

  async recordSupportAccessGrantExpired(input: SupportAccessGrantExpiredInput): Promise<void> {
    await this.append({
      actorType: AuditActorType.SYSTEM,
      actorId: null,
      tenantId: input.tenantId,
      action: 'support_access.grant.expired',
      subjectType: 'support_access_grant',
      subjectId: input.grantId,
      occurredAt: input.occurredAt ?? new Date(),
      payload: {},
    });
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
