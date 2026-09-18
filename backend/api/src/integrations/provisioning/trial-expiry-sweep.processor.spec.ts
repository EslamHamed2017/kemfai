import controlDataSource from '../../database/data-source';
import { Tenant, TenantStatus } from '../../modules/tenants/entities/tenant.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from '../../modules/billing-customer/entities/subscription.entity';
import { AuditEvent } from '../../modules/audit/entities/audit-event.entity';
import { AuditService } from '../../modules/audit/audit.service';
import {
  EntitlementsService,
  EntitlementSet,
} from '../../modules/entitlements/entitlements.service';
import { TrialExpirySweepProcessor } from './trial-expiry-sweep.processor';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLAN_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: TENANT_A,
    accountId: 'account-a',
    status: TenantStatus.READY,
    odooDbName: 'kemfai_tenant_a',
    minioBucket: 'tenant-a',
    provisioningAttempts: 1,
    failureReason: null,
    createdAt: new Date(),
    readyAt: new Date(Date.now() - 20 * MS_PER_DAY),
    ...overrides,
  } as Tenant;
}

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-row',
    tenantId: TENANT_A,
    planId: PLAN_A,
    billingCycle: SubscriptionBillingCycle.MONTHLY,
    status: SubscriptionStatus.PENDING_ACTIVATION,
    currentPeriodStart: '2026-01-01',
    currentPeriodEnd: '2026-01-31',
    activatedAt: null,
    activatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Subscription;
}

function entitlementSet(overrides: Partial<EntitlementSet> = {}): EntitlementSet {
  return {
    planId: PLAN_A,
    features: [],
    trialWindowDays: 14,
    autoRestrictUnpaid: true,
    featureFlags: [],
    ...overrides,
  };
}

function mockRepos(options: {
  tenants?: Tenant[];
  subscription?: Subscription | null;
  alreadyRestricted?: boolean;
}) {
  const subscriptionFindOne = jest.fn().mockResolvedValue(options.subscription ?? null);
  const auditExists = jest.fn().mockResolvedValue(options.alreadyRestricted ?? false);
  const tenantQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(options.tenants ?? []),
  };

  jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: any) => {
    if (target === Tenant) {
      return { createQueryBuilder: jest.fn().mockReturnValue(tenantQueryBuilder) } as any;
    }
    if (target === Subscription) {
      return { findOne: subscriptionFindOne } as any;
    }
    if (target === AuditEvent) {
      return { exists: auditExists } as any;
    }
    throw new Error(`Unexpected repository requested for ${String(target)}`);
  });

  return { subscriptionFindOne, auditExists };
}

function makeProcessor(recordTenantTrialRestricted: jest.Mock, getEntitlementSet: jest.Mock) {
  return new TrialExpirySweepProcessor(
    { recordTenantTrialRestricted } as unknown as AuditService,
    { getEntitlementSet } as unknown as EntitlementsService,
  );
}

/**
 * T102 acceptance criteria: idempotent double-audit protection, Active-before-sweep never
 * restricted, and this job is observability-only (asserted implicitly — the processor never
 * touches Tenant/Subscription rows, only reads them and appends to AuditEvent).
 */
describe('TrialExpirySweepProcessor (T102)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits tenant.trial.restricted the first time an unpaid tenant crosses its trial window', async () => {
    mockRepos({
      tenants: [tenant({ readyAt: new Date(Date.now() - 20 * MS_PER_DAY) })],
      subscription: subscription({ status: SubscriptionStatus.PENDING_ACTIVATION }),
      alreadyRestricted: false,
    });
    const recordTenantTrialRestricted = jest.fn().mockResolvedValue(undefined);
    const getEntitlementSet = jest
      .fn()
      .mockResolvedValue(entitlementSet({ autoRestrictUnpaid: true, trialWindowDays: 14 }));
    const processor = makeProcessor(recordTenantTrialRestricted, getEntitlementSet);

    await processor.process({} as any);

    expect(recordTenantTrialRestricted).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        trialWindowDays: 14,
        elapsedDays: 20,
        autoRestrictUnpaid: true,
      }),
    );
  });

  it('does not double-audit a tenant already carrying a tenant.trial.restricted event (idempotency, mirrors T086)', async () => {
    mockRepos({
      tenants: [tenant()],
      subscription: subscription({ status: SubscriptionStatus.PENDING_ACTIVATION }),
      alreadyRestricted: true,
    });
    const recordTenantTrialRestricted = jest.fn().mockResolvedValue(undefined);
    const getEntitlementSet = jest.fn().mockResolvedValue(entitlementSet());
    const processor = makeProcessor(recordTenantTrialRestricted, getEntitlementSet);

    await processor.process({} as any);
    await processor.process({} as any);

    expect(recordTenantTrialRestricted).not.toHaveBeenCalled();
  });

  it('never restricts a tenant whose Subscription is Active, regardless of elapsed time', async () => {
    mockRepos({
      tenants: [tenant({ readyAt: new Date(Date.now() - 999 * MS_PER_DAY) })],
      subscription: subscription({ status: SubscriptionStatus.ACTIVE }),
    });
    const recordTenantTrialRestricted = jest.fn().mockResolvedValue(undefined);
    const getEntitlementSet = jest.fn();
    const processor = makeProcessor(recordTenantTrialRestricted, getEntitlementSet);

    await processor.process({} as any);

    expect(getEntitlementSet).not.toHaveBeenCalled();
    expect(recordTenantTrialRestricted).not.toHaveBeenCalled();
  });

  it('skips a tenant with no Subscription row yet', async () => {
    mockRepos({ tenants: [tenant()], subscription: null });
    const recordTenantTrialRestricted = jest.fn().mockResolvedValue(undefined);
    const getEntitlementSet = jest.fn();
    const processor = makeProcessor(recordTenantTrialRestricted, getEntitlementSet);

    await processor.process({} as any);

    expect(getEntitlementSet).not.toHaveBeenCalled();
    expect(recordTenantTrialRestricted).not.toHaveBeenCalled();
  });

  it('never restricts when the resolved autoRestrictUnpaid is false, however long the trial has elapsed', async () => {
    mockRepos({
      tenants: [tenant({ readyAt: new Date(Date.now() - 999 * MS_PER_DAY) })],
      subscription: subscription({ status: SubscriptionStatus.PENDING_ACTIVATION }),
    });
    const recordTenantTrialRestricted = jest.fn().mockResolvedValue(undefined);
    const getEntitlementSet = jest
      .fn()
      .mockResolvedValue(entitlementSet({ autoRestrictUnpaid: false, trialWindowDays: 1 }));
    const processor = makeProcessor(recordTenantTrialRestricted, getEntitlementSet);

    await processor.process({} as any);

    expect(recordTenantTrialRestricted).not.toHaveBeenCalled();
  });

  it('does not restrict while elapsed time is within the resolved trial window', async () => {
    mockRepos({
      tenants: [tenant({ readyAt: new Date(Date.now() - 5 * MS_PER_DAY) })],
      subscription: subscription({ status: SubscriptionStatus.PENDING_ACTIVATION }),
    });
    const recordTenantTrialRestricted = jest.fn().mockResolvedValue(undefined);
    const getEntitlementSet = jest
      .fn()
      .mockResolvedValue(entitlementSet({ autoRestrictUnpaid: true, trialWindowDays: 14 }));
    const processor = makeProcessor(recordTenantTrialRestricted, getEntitlementSet);

    await processor.process({} as any);

    expect(recordTenantTrialRestricted).not.toHaveBeenCalled();
  });

  it('a tenant whose Subscription becomes Active before the sweep runs is never restricted, even after a prior non-Active tick', async () => {
    const repos = mockRepos({
      tenants: [tenant({ readyAt: new Date(Date.now() - 20 * MS_PER_DAY) })],
      subscription: subscription({ status: SubscriptionStatus.PENDING_ACTIVATION }),
      alreadyRestricted: false,
    });
    const recordTenantTrialRestricted = jest.fn().mockResolvedValue(undefined);
    const getEntitlementSet = jest
      .fn()
      .mockResolvedValue(entitlementSet({ autoRestrictUnpaid: true, trialWindowDays: 14 }));
    const processor = makeProcessor(recordTenantTrialRestricted, getEntitlementSet);

    // Subscription activates in between two ticks — second tick must see Active and skip.
    repos.subscriptionFindOne.mockResolvedValueOnce(
      subscription({ status: SubscriptionStatus.PENDING_ACTIVATION }),
    );
    repos.subscriptionFindOne.mockResolvedValueOnce(
      subscription({ status: SubscriptionStatus.ACTIVE }),
    );

    await processor.process({} as any);
    await processor.process({} as any);

    expect(recordTenantTrialRestricted).toHaveBeenCalledTimes(1);
  });
});
