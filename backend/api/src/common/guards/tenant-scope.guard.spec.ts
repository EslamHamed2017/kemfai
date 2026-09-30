import { ExecutionContext, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantScopeGuard } from './tenant-scope.guard';
import { requireReadyWorkspaceOwner } from './workspace-owner-access';
jest.mock('./workspace-owner-access', () => ({
  requireReadyWorkspaceOwner: jest.fn().mockResolvedValue(undefined),
}));
import { TenantContextResolver } from '../tenant-context/tenant-context.resolver';
import { TenantOwnershipRegistry } from '../tenant-context/tenant-ownership.registry';
import {
  TenantOwnedResourceRef,
  TenantScopedRequest,
} from '../tenant-context/tenant-context.model';
import { AuditService } from '../../modules/audit/audit.service';
import { AuditActorType } from '../../modules/audit/entities/audit-event.entity';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUBSCRIPTION_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

interface RequestInit {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, unknown>;
}

function makeRequest(init: RequestInit = {}, authenticated = true): TenantScopedRequest {
  return {
    method: 'GET',
    originalUrl: '/test-scope/resource',
    params: init.params ?? {},
    query: init.query ?? {},
    body: init.body ?? {},
    headers: init.headers ?? {},
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

function makeReflector(opts: { isPublic?: boolean; ownedRefs?: TenantOwnedResourceRef[] } = {}) {
  return {
    getAllAndOverride: jest.fn(() => opts.isPublic ?? false),
    getAllAndMerge: jest.fn().mockReturnValue(opts.ownedRefs ?? []),
  } as unknown as Reflector;
}

interface Fixture {
  guard: TenantScopeGuard;
  resolver: { resolveForRequest: jest.Mock };
  registry: { resolveOwningTenantId: jest.Mock };
  audit: { append: jest.Mock };
}

function makeFixture(
  reflectorOpts: { isPublic?: boolean; ownedRefs?: TenantOwnedResourceRef[] } = {},
  caller: { accountId: string | null; callerTenantId: string | null } = {
    accountId: ACCOUNT_A,
    callerTenantId: TENANT_A,
  },
): Fixture {
  const resolver = {
    resolveForRequest: jest.fn().mockResolvedValue({ keycloakUserId: 'sub-a', ...caller }),
  };
  const registry = { resolveOwningTenantId: jest.fn() };
  const audit = { append: jest.fn().mockResolvedValue(undefined) };
  const guard = new TenantScopeGuard(
    makeReflector(reflectorOpts),
    resolver as unknown as TenantContextResolver,
    registry as unknown as TenantOwnershipRegistry,
    audit as unknown as AuditService,
  );
  return { guard, resolver, registry, audit };
}

describe('TenantScopeGuard (T017)', () => {
  it('passes @Public() routes without resolving tenant context', async () => {
    const f = makeFixture({ isPublic: true });
    await expect(f.guard.canActivate(makeContext(makeRequest()))).resolves.toBe(true);
    expect(f.resolver.resolveForRequest).not.toHaveBeenCalled();
    expect(f.audit.append).not.toHaveBeenCalled();
  });

  it('passes when no authenticated identity is attached (authentication is another guard’s job)', async () => {
    const f = makeFixture();
    await expect(f.guard.canActivate(makeContext(makeRequest({}, false)))).resolves.toBe(true);
    expect(f.resolver.resolveForRequest).not.toHaveBeenCalled();
  });

  it('passes an authenticated request that references no tenant-owned thing', async () => {
    const f = makeFixture();
    await expect(f.guard.canActivate(makeContext(makeRequest()))).resolves.toBe(true);
    expect(f.audit.append).not.toHaveBeenCalled();
  });

  it('requires a Ready owner for any tenant-bearing customer request', async () => {
    const f = makeFixture();
    const check = jest.mocked(requireReadyWorkspaceOwner);
    check.mockRejectedValueOnce(new ForbiddenException('Workspace owner access denied'));
    await expect(
      f.guard.canActivate(makeContext(makeRequest({ params: { tenantId: TENANT_A } }))),
    ).rejects.toThrow(ForbiddenException);
    expect(f.audit.append).not.toHaveBeenCalled();
  });

  it('passes when the caller names exactly its own tenant explicitly', async () => {
    const f = makeFixture();
    const req = makeRequest({ params: { tenantId: TENANT_A } });
    await expect(f.guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(f.audit.append).not.toHaveBeenCalled();
  });

  it.each([
    ['path param', (req: TenantScopedRequest) => void (req.params = { tenantId: TENANT_B })],
    ['query param', (req: TenantScopedRequest) => void (req.query = { tenant_id: TENANT_B })],
    ['body field', (req: TenantScopedRequest) => void (req.body = { tenantId: TENANT_B })],
    [
      'x-tenant-id header',
      (req: TenantScopedRequest) => void (req.headers = { 'x-tenant-id': TENANT_B }),
    ],
  ])(
    'denies an explicit tenantId of Tenant B carried in a %s and audits before exiting',
    async (_label, shape) => {
      const f = makeFixture();
      const order: string[] = [];
      f.audit.append.mockImplementation(async () => {
        order.push('audit');
      });

      const req = makeRequest();
      shape(req);
      await expect(f.guard.canActivate(makeContext(req))).rejects.toThrow(ForbiddenException);
      expect(order).toEqual(['audit']);
      expect(f.audit.append).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tenant_access.denied_cross_tenant',
          actorType: AuditActorType.ACCOUNT,
          actorId: ACCOUNT_A,
          tenantId: TENANT_A,
          subjectType: 'tenant',
          payload: expect.objectContaining({ target_tenant_id: TENANT_B }),
        }),
      );
    },
  );

  it('denies a Tenant B resource addressed by ordinary resource ID (ownership-resolved)', async () => {
    const f = makeFixture({
      ownedRefs: [{ resource: 'subscription', idParam: 'id' }],
    });
    f.registry.resolveOwningTenantId.mockResolvedValue(TENANT_B);
    const order: string[] = [];
    f.audit.append.mockImplementation(async () => {
      order.push('audit');
    });

    const req = makeRequest({ params: { id: SUBSCRIPTION_B } });
    await expect(f.guard.canActivate(makeContext(req))).rejects.toThrow(ForbiddenException);

    expect(f.registry.resolveOwningTenantId).toHaveBeenCalledWith('subscription', SUBSCRIPTION_B);
    expect(order).toEqual(['audit']);
    expect(f.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant_access.denied_cross_tenant',
        tenantId: TENANT_A,
        subjectType: 'subscription',
        subjectId: SUBSCRIPTION_B,
        payload: expect.objectContaining({ target_tenant_id: TENANT_B }),
      }),
    );
  });

  it('passes a resource addressed by ordinary ID when the registry resolves it to the caller’s own tenant', async () => {
    const f = makeFixture({
      ownedRefs: [{ resource: 'subscription', idParam: 'id' }],
    });
    f.registry.resolveOwningTenantId.mockResolvedValue(TENANT_A);
    const req = makeRequest({ params: { id: SUBSCRIPTION_B } });
    await expect(f.guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(f.audit.append).not.toHaveBeenCalled();
  });

  it('passes through an unresolvable resource ID (handler answers 404) without auditing a denial', async () => {
    const f = makeFixture({
      ownedRefs: [{ resource: 'subscription', idParam: 'id' }],
    });
    f.registry.resolveOwningTenantId.mockResolvedValue(null);
    const req = makeRequest({ params: { id: SUBSCRIPTION_B } });
    await expect(f.guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(f.audit.append).not.toHaveBeenCalled();
  });

  it('denies a caller with no tenant that references an existing tenant-owned resource', async () => {
    const f = makeFixture({}, { accountId: ACCOUNT_A, callerTenantId: null });
    const req = makeRequest({ params: { tenantId: TENANT_B } });
    await expect(f.guard.canActivate(makeContext(req))).rejects.toThrow(ForbiddenException);
    expect(f.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ACCOUNT_A,
        tenantId: null,
        payload: expect.objectContaining({ target_tenant_id: TENANT_B }),
      }),
    );
  });

  it('fails closed with 500 — never an unaudited 403 — when the audit write itself fails', async () => {
    const f = makeFixture();
    f.audit.append.mockRejectedValue(new Error('audit DB down'));
    const req = makeRequest({ params: { tenantId: TENANT_B } });

    await expect(f.guard.canActivate(makeContext(req))).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(f.audit.append).toHaveBeenCalledTimes(1);
  });
});
