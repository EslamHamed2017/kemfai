import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import controlDataSource from '../../database/data-source';
import { Tenant, TenantStatus } from '../../modules/tenants/entities/tenant.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from '../../modules/billing-customer/entities/subscription.entity';
import {
  EntitlementsService,
  EntitlementSet,
} from '../../modules/entitlements/entitlements.service';
import { AuditService } from '../../modules/audit/audit.service';
import { TenantContextResolver } from '../tenant-context/tenant-context.resolver';
import { TenantScopedRequest } from '../tenant-context/tenant-context.model';
import { TrialWindowGuard } from './trial-window.guard';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLAN_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function makeRequest(authenticated = true): TenantScopedRequest {
  return {
    method: 'GET',
    originalUrl: '/companies/current/setup',
    params: {},
    query: {},
    body: {},
    headers: {},
    ...(authenticated ? { auth: { keycloakUserId: 'sub-a' } } : {}),
  } as TenantScopedRequest;
}

function makeContext(req: TenantScopedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

function makeReflector(opts: { isPublic?: boolean; enforced?: boolean }) {
  return {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === 'kemfai:isPublicRoute') return opts.isPublic ?? false;
      if (key === 'kemfai:enforceTrialWindow') return opts.enforced ?? false;
      return undefined;
    }),
  } as unknown as Reflector;
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
    readyAt: new Date(),
    ...overrides,
  } as Tenant;
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

function mockRepos(options: { tenant?: Tenant | null; subscription?: Subscription | null }) {
  jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: any) => {
    if (target === Tenant) {
      return { findOne: jest.fn().mockResolvedValue(options.tenant ?? null) } as any;
    }
    if (target === Subscription) {
      return { findOne: jest.fn().mockResolvedValue(options.subscription ?? null) } as any;
    }
    throw new Error(`Unexpected repository requested for ${String(target)}`);
  });
}

function makeGuard(
  reflector: Reflector,
  resolveForRequest: jest.Mock,
  getEntitlementSet: jest.Mock,
  recordTenantTrialRestricted: jest.Mock = jest.fn().mockResolvedValue(undefined),
) {
  return new TrialWindowGuard(
    reflector,
    { resolveForRequest } as unknown as TenantContextResolver,
    { getEntitlementSet } as unknown as EntitlementsService,
    { recordTenantTrialRestricted } as unknown as AuditService,
  );
}

describe('TrialWindowGuard (T101)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes @Public() routes without resolving tenant context', async () => {
    const resolveForRequest = jest.fn();
    const guard = makeGuard(makeReflector({ isPublic: true }), resolveForRequest, jest.fn());

    await expect(guard.canActivate(makeContext(makeRequest()))).resolves.toBe(true);
    expect(resolveForRequest).not.toHaveBeenCalled();
  });

  it('passes a route with no @EnforceTrialWindow() declared', async () => {
    const resolveForRequest = jest.fn();
    const guard = makeGuard(makeReflector({}), resolveForRequest, jest.fn());

    await expect(guard.canActivate(makeContext(makeRequest()))).resolves.toBe(true);
    expect(resolveForRequest).not.toHaveBeenCalled();
  });

  it('passes when no authenticated identity is attached (authentication is another guard’s job)', async () => {
    const resolveForRequest = jest.fn();
    const guard = makeGuard(makeReflector({ enforced: true }), resolveForRequest, jest.fn());

    await expect(guard.canActivate(makeContext(makeRequest(false)))).resolves.toBe(true);
    expect(resolveForRequest).not.toHaveBeenCalled();
  });

  it('passes when the caller has no tenant yet', async () => {
    const resolveForRequest = jest.fn().mockResolvedValue({ callerTenantId: null });
    const getEntitlementSet = jest.fn();
    const guard = makeGuard(
      makeReflector({ enforced: true }),
      resolveForRequest,
      getEntitlementSet,
    );

    await expect(guard.canActivate(makeContext(makeRequest()))).resolves.toBe(true);
    expect(getEntitlementSet).not.toHaveBeenCalled();
  });

  it('bypasses restriction unconditionally when the Subscription is Active, regardless of elapsed time', async () => {
    const resolveForRequest = jest.fn().mockResolvedValue({ callerTenantId: TENANT_A });
    mockRepos({
      subscription: subscription({ status: SubscriptionStatus.ACTIVE }),
      tenant: tenant({ readyAt: new Date(Date.now() - 999 * MS_PER_DAY) }),
    });
    const getEntitlementSet = jest.fn();
    const guard = makeGuard(
      makeReflector({ enforced: true }),
      resolveForRequest,
      getEntitlementSet,
    );

    await expect(guard.canActivate(makeContext(makeRequest()))).resolves.toBe(true);
    expect(getEntitlementSet).not.toHaveBeenCalled();
  });

  it('passes when the tenant has not finished provisioning (no ready_at)', async () => {
    const resolveForRequest = jest.fn().mockResolvedValue({ callerTenantId: TENANT_A });
    mockRepos({ subscription: subscription(), tenant: tenant({ readyAt: null }) });
    const getEntitlementSet = jest.fn();
    const guard = makeGuard(
      makeReflector({ enforced: true }),
      resolveForRequest,
      getEntitlementSet,
    );

    await expect(guard.canActivate(makeContext(makeRequest()))).resolves.toBe(true);
    expect(getEntitlementSet).not.toHaveBeenCalled();
  });

  it('passes when no Subscription row exists yet for the tenant', async () => {
    const resolveForRequest = jest.fn().mockResolvedValue({ callerTenantId: TENANT_A });
    mockRepos({ subscription: null, tenant: tenant() });
    const getEntitlementSet = jest.fn();
    const guard = makeGuard(
      makeReflector({ enforced: true }),
      resolveForRequest,
      getEntitlementSet,
    );

    await expect(guard.canActivate(makeContext(makeRequest()))).resolves.toBe(true);
    expect(getEntitlementSet).not.toHaveBeenCalled();
  });

  it('never restricts when the resolved autoRestrictUnpaid is false, however long the trial has elapsed', async () => {
    const resolveForRequest = jest.fn().mockResolvedValue({ callerTenantId: TENANT_A });
    mockRepos({
      subscription: subscription({ status: SubscriptionStatus.PENDING_ACTIVATION }),
      tenant: tenant({ readyAt: new Date(Date.now() - 999 * MS_PER_DAY) }),
    });
    const getEntitlementSet = jest
      .fn()
      .mockResolvedValue(entitlementSet({ autoRestrictUnpaid: false, trialWindowDays: 1 }));
    const guard = makeGuard(
      makeReflector({ enforced: true }),
      resolveForRequest,
      getEntitlementSet,
    );

    await expect(guard.canActivate(makeContext(makeRequest()))).resolves.toBe(true);
    expect(getEntitlementSet).toHaveBeenCalledWith(PLAN_A);
  });

  it('passes while elapsed time is within the resolved trial window', async () => {
    const resolveForRequest = jest.fn().mockResolvedValue({ callerTenantId: TENANT_A });
    mockRepos({
      subscription: subscription({ status: SubscriptionStatus.PENDING_ACTIVATION }),
      tenant: tenant({ readyAt: new Date(Date.now() - 5 * MS_PER_DAY) }),
    });
    const getEntitlementSet = jest
      .fn()
      .mockResolvedValue(entitlementSet({ autoRestrictUnpaid: true, trialWindowDays: 14 }));
    const guard = makeGuard(
      makeReflector({ enforced: true }),
      resolveForRequest,
      getEntitlementSet,
    );

    await expect(guard.canActivate(makeContext(makeRequest()))).resolves.toBe(true);
  });

  it('denies once elapsed time exceeds the resolved trial window with auto-restriction enabled and no Active subscription', async () => {
    const resolveForRequest = jest.fn().mockResolvedValue({ callerTenantId: TENANT_A });
    mockRepos({
      subscription: subscription({ status: SubscriptionStatus.PENDING_ACTIVATION }),
      tenant: tenant({ readyAt: new Date(Date.now() - 20 * MS_PER_DAY) }),
    });
    const getEntitlementSet = jest
      .fn()
      .mockResolvedValue(entitlementSet({ autoRestrictUnpaid: true, trialWindowDays: 14 }));
    const recordTenantTrialRestricted = jest.fn().mockResolvedValue(undefined);
    const guard = makeGuard(
      makeReflector({ enforced: true }),
      resolveForRequest,
      getEntitlementSet,
      recordTenantTrialRestricted,
    );

    await expect(guard.canActivate(makeContext(makeRequest()))).rejects.toThrow(ForbiddenException);
    expect(recordTenantTrialRestricted).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      trialWindowDays: 14,
      elapsedDays: 20,
      autoRestrictUnpaid: true,
    });
  });

  it('denies identically regardless of how the request arrived (no separate UI-only code path exists)', async () => {
    const resolveForRequest = jest.fn().mockResolvedValue({ callerTenantId: TENANT_A });
    mockRepos({
      subscription: subscription({ status: SubscriptionStatus.SUSPENDED }),
      tenant: tenant({ readyAt: new Date(Date.now() - 30 * MS_PER_DAY) }),
    });
    const getEntitlementSet = jest
      .fn()
      .mockResolvedValue(entitlementSet({ autoRestrictUnpaid: true, trialWindowDays: 14 }));
    const recordTenantTrialRestricted = jest.fn().mockResolvedValue(undefined);
    const guard = makeGuard(
      makeReflector({ enforced: true }),
      resolveForRequest,
      getEntitlementSet,
      recordTenantTrialRestricted,
    );

    await expect(guard.canActivate(makeContext(makeRequest()))).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(makeContext(makeRequest()))).rejects.toThrow(ForbiddenException);
    expect(recordTenantTrialRestricted).toHaveBeenCalledTimes(2);
  });
});
