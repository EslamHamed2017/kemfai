import { AuditService } from './audit.service';
import { AuditActorType } from './entities/audit-event.entity';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INTERNAL_USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUBJECT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/**
 * Every action in contracts/events.md's catalog table must have a corresponding, correctly
 * shaped emission call site reachable from AuditService (T019 acceptance criterion). Each
 * test below drives one `record*` method and asserts the exact event `append` receives:
 * actor_type, actor_id (null iff system), tenant_id, subject_type/subject_id, and payload.
 */
describe('AuditService — FR-007 event catalog (T019)', () => {
  let service: AuditService;
  let appendSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new AuditService();
    appendSpy = jest.spyOn(service, 'append').mockResolvedValue(undefined);
  });

  it('account.created', async () => {
    await service.recordAccountCreated({
      accountId: ACCOUNT,
      planId: 'plan-1',
      billingCycle: 'monthly',
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'account.created',
        actorType: AuditActorType.ACCOUNT,
        actorId: ACCOUNT,
        tenantId: null,
        subjectType: 'account',
        subjectId: ACCOUNT,
        payload: { plan_id: 'plan-1', billing_cycle: 'monthly' },
      }),
    );
  });

  it('account.email_verified', async () => {
    await service.recordAccountEmailVerified({ accountId: ACCOUNT });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'account.email_verified',
        actorType: AuditActorType.ACCOUNT,
        actorId: ACCOUNT,
        tenantId: null,
        subjectType: 'account',
        subjectId: ACCOUNT,
        payload: {},
      }),
    );
  });

  it('account.mfa_enrolled — tenant present once assigned', async () => {
    await service.recordAccountMfaEnrolled({ accountId: ACCOUNT, tenantId: TENANT });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'account.mfa_enrolled',
        actorType: AuditActorType.ACCOUNT,
        tenantId: TENANT,
        subjectType: 'account',
        subjectId: ACCOUNT,
      }),
    );
  });

  it('account.mfa_enrolled — tenant still null pre-provisioning', async () => {
    await service.recordAccountMfaEnrolled({ accountId: ACCOUNT, tenantId: null });
    expect(appendSpy).toHaveBeenCalledWith(expect.objectContaining({ tenantId: null }));
  });

  it('tenant.provisioning.attempted — system actor, no actor_id', async () => {
    await service.recordTenantProvisioningAttempted({ tenantId: TENANT, attemptNumber: 2 });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.provisioning.attempted',
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        tenantId: TENANT,
        subjectType: 'tenant',
        subjectId: TENANT,
        payload: { attempt_number: 2 },
      }),
    );
  });

  it('tenant.provisioning.succeeded', async () => {
    await service.recordTenantProvisioningSucceeded({
      tenantId: TENANT,
      odooDbName: 'kemfai_tenant_1',
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.provisioning.succeeded',
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        payload: { odoo_db_name: 'kemfai_tenant_1' },
      }),
    );
  });

  it('tenant.provisioning.failed', async () => {
    await service.recordTenantProvisioningFailed({
      tenantId: TENANT,
      failureReason: 'odoo_db_create_error',
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.provisioning.failed',
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        payload: { failure_reason: 'odoo_db_create_error' },
      }),
    );
  });

  it('company.setup.completed', async () => {
    await service.recordCompanySetupCompleted({
      accountId: ACCOUNT,
      tenantId: TENANT,
      companyId: SUBJECT,
      odooDbName: 'tenant-db-1',
      odooCompanyId: 7,
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'company.setup.completed',
        actorType: AuditActorType.ACCOUNT,
        actorId: ACCOUNT,
        tenantId: TENANT,
        subjectType: 'company',
        subjectId: SUBJECT,
        payload: { odoo_db_name: 'tenant-db-1', odoo_company_id: 7 },
        // T055 remediation — this is the DB-enforced "ensure exactly once per tenant"
        // anchor (uq_audit_event_dedupe_key) that lets a retry observing
        // alreadyComplete=true safely call this method again without duplicating the row.
        dedupeKey: `company.setup.completed:${TENANT}`,
      }),
    );
  });

  it('company.settings.updated', async () => {
    await service.recordCompanySettingsUpdated({
      accountId: ACCOUNT,
      tenantId: TENANT,
      companyId: SUBJECT,
      odooDbName: 'tenant-db-1',
      odooCompanyId: 7,
      changedFields: ['base_currency', 'vat_tax_registration'],
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'company.settings.updated',
        payload: {
          changed_fields: ['base_currency', 'vat_tax_registration'],
          odoo_db_name: 'tenant-db-1',
          odoo_company_id: 7,
        },
        // No idempotencyKey supplied -> no dedupe anchor, unconstrained append (unchanged
        // pre-remediation behavior for a caller that sends no Idempotency-Key header).
        dedupeKey: undefined,
      }),
    );
  });

  it('company.settings.updated with a client-supplied idempotencyKey gets a per-tenant+key dedupe anchor (T055 remediation)', async () => {
    await service.recordCompanySettingsUpdated({
      accountId: ACCOUNT,
      tenantId: TENANT,
      companyId: SUBJECT,
      odooDbName: 'tenant-db-1',
      odooCompanyId: 7,
      changedFields: ['legal_name'],
      idempotencyKey: 'client-key-42',
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'company.settings.updated',
        dedupeKey: `company.settings.updated:${TENANT}:client-key-42`,
      }),
    );
  });

  it('modules.selection.changed', async () => {
    await service.recordModulesSelectionChanged({
      accountId: ACCOUNT,
      tenantId: TENANT,
      moduleSelectionId: SUBJECT,
      added: ['inventory'],
      removed: ['hr'],
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'modules.selection.changed',
        subjectType: 'module_selection',
        payload: { added: ['inventory'], removed: ['hr'] },
      }),
    );
  });

  it('billing.payment_submission.created', async () => {
    await service.recordBillingPaymentSubmissionCreated({
      accountId: ACCOUNT,
      tenantId: TENANT,
      paymentSubmissionId: SUBJECT,
      bankReference: 'REF-123',
      amount: '199.00',
      currency: 'USD',
      billingPeriodStart: '2026-09-01',
      billingPeriodEnd: '2026-09-30',
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.payment_submission.created',
        subjectType: 'payment_submission',
        payload: expect.objectContaining({
          bank_reference: 'REF-123',
          amount: '199.00',
          currency: 'USD',
          billing_period: { start: '2026-09-01', end: '2026-09-30' },
        }),
      }),
    );
  });

  it('billing.payment_submission.decided — internal_user actor', async () => {
    const reviewedAt = new Date('2026-09-18T10:00:00Z');
    await service.recordBillingPaymentSubmissionDecided({
      reviewerInternalUserId: INTERNAL_USER,
      tenantId: TENANT,
      paymentSubmissionId: SUBJECT,
      decision: 'approve',
      reviewedAt,
      notes: 'looks good',
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.payment_submission.decided',
        actorType: AuditActorType.INTERNAL_USER,
        actorId: INTERNAL_USER,
        payload: {
          decision: 'approve',
          reviewed_by: INTERNAL_USER,
          reviewed_at: reviewedAt.toISOString(),
          notes: 'looks good',
        },
      }),
    );
  });

  it('billing.subscription.activated — internal_user actor', async () => {
    const activatedAt = new Date('2026-09-18T10:05:00Z');
    await service.recordBillingSubscriptionActivated({
      activatedByInternalUserId: INTERNAL_USER,
      tenantId: TENANT,
      subscriptionId: SUBJECT,
      activatedAt,
      billingPeriodStart: '2026-09-01',
      billingPeriodEnd: '2026-09-30',
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.subscription.activated',
        actorType: AuditActorType.INTERNAL_USER,
        subjectType: 'subscription',
        payload: expect.objectContaining({ activated_by: INTERNAL_USER }),
      }),
    );
  });

  it('support_access.grant.created', async () => {
    const expiresAt = new Date('2026-09-19T00:00:00Z');
    await service.recordSupportAccessGrantCreated({
      accountId: ACCOUNT,
      tenantId: TENANT,
      grantId: SUBJECT,
      granteeRole: 'Support',
      expiresAt,
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'support_access.grant.created',
        actorType: AuditActorType.ACCOUNT,
        payload: { grantee_role: 'Support', expires_at: expiresAt.toISOString() },
      }),
    );
  });

  it('support_access.grant.used — internal_user actor', async () => {
    await service.recordSupportAccessGrantUsed({
      internalUserId: INTERNAL_USER,
      tenantId: TENANT,
      grantId: SUBJECT,
      actionSummary: 'GET /companies/current/setup',
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'support_access.grant.used',
        actorType: AuditActorType.INTERNAL_USER,
        actorId: INTERNAL_USER,
        payload: { action_summary: 'GET /companies/current/setup' },
      }),
    );
  });

  it('support_access.grant.denied — internal_user actor', async () => {
    await service.recordSupportAccessGrantDenied({
      internalUserId: INTERNAL_USER,
      tenantId: TENANT,
      grantId: SUBJECT,
      denialReason: 'expired',
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'support_access.grant.denied',
        payload: { denial_reason: 'expired' },
      }),
    );
  });

  it('support_access.grant.revoked — account actor', async () => {
    await service.recordSupportAccessGrantRevoked({
      accountId: ACCOUNT,
      tenantId: TENANT,
      grantId: SUBJECT,
      revokedBy: ACCOUNT,
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'support_access.grant.revoked',
        actorType: AuditActorType.ACCOUNT,
        payload: { revoked_by: ACCOUNT },
      }),
    );
  });

  it('support_access.grant.expired — system actor, no actor_id', async () => {
    await service.recordSupportAccessGrantExpired({ tenantId: TENANT, grantId: SUBJECT });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'support_access.grant.expired',
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        payload: {},
      }),
    );
  });

  it('tenant.trial.restricted — system actor, no actor_id', async () => {
    await service.recordTenantTrialRestricted({
      tenantId: TENANT,
      trialWindowDays: 14,
      elapsedDays: 15,
      autoRestrictUnpaid: true,
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.trial.restricted',
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        subjectType: 'tenant',
        subjectId: TENANT,
        payload: { trial_window_days: 14, elapsed_days: 15, auto_restrict_unpaid: true },
      }),
    );
  });

  it('tenant_access.denied_cross_tenant — requesting tenant, not target, is tenant_id', async () => {
    await service.recordTenantAccessDeniedCrossTenant({
      actorType: AuditActorType.ACCOUNT,
      actorId: ACCOUNT,
      requestingTenantId: TENANT,
      resourceType: 'subscription',
      resourceId: SUBJECT,
      targetTenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      resourcePath: 'GET /billing/subscription',
    });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant_access.denied_cross_tenant',
        tenantId: TENANT,
        subjectType: 'subscription',
        subjectId: SUBJECT,
        payload: {
          target_tenant_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          resource_path: 'GET /billing/subscription',
        },
      }),
    );
  });

  it('defaults occurredAt to now() when not supplied', async () => {
    const before = Date.now();
    await service.recordAccountEmailVerified({ accountId: ACCOUNT });
    const after = Date.now();
    const call = appendSpy.mock.calls[0][0];
    expect(call.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(call.occurredAt.getTime()).toBeLessThanOrEqual(after);
  });
});
