import { ExecutionContext, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import controlDataSource from '../../database/data-source';
import {
  SupportAccessGrant,
  SupportAccessGranteeRole,
} from '../../modules/support-access/entities/support-access-grant.entity';
import { SupportAccessUsage } from '../../modules/support-access/entities/support-access-usage.entity';
import { RoleGuard } from './role.guard';
import { TenantOwnershipRegistry } from '../tenant-context/tenant-ownership.registry';
import {
  TenantOwnedResourceRef,
  TenantScopedRequest,
} from '../tenant-context/tenant-context.model';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUPPORT_USER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const GRANT_ACTIVE = '11111111-1111-4111-8111-111111111111';
const GRANT_EXPIRED = '22222222-2222-4222-8222-222222222222';
const GRANT_REVOKED = '33333333-3333-4333-8333-333333333333';

interface RequestInit {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  roles?: string[];
}

function makeRequest(init: RequestInit = {}): TenantScopedRequest {
  return {
    method: 'GET',
    originalUrl: '/test-role/resource',
    params: init.params ?? {},
    query: init.query ?? {},
    body: {},
    headers: {},
    auth: { keycloakUserId: SUPPORT_USER, roles: init.roles ?? [] },
  } as TenantScopedRequest;
}

function makeContext(req: TenantScopedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

function makeReflector(opts: {
  isPublic?: boolean;
  requiredRoles?: string[];
  ownedRefs?: TenantOwnedResourceRef[];
}) {
  return {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === 'kemfai:isPublicRoute') return opts.isPublic ?? false;
      if (key === 'kemfai:requiredRoles') return opts.requiredRoles;
      return undefined;
    }),
    getAllAndMerge: jest.fn().mockReturnValue(opts.ownedRefs ?? []),
  } as unknown as Reflector;
}

function grant(overrides: Partial<SupportAccessGrant>): SupportAccessGrant {
  return {
    id: GRANT_ACTIVE,
    tenantId: TENANT_A,
    grantedBy: 'someone',
    granteeRole: SupportAccessGranteeRole.SUPPORT,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as SupportAccessGrant;
}

function mockRepos(options: {
  grants?: SupportAccessGrant[];
  insertImpl?: () => Promise<unknown>;
}) {
  const insert = jest.fn(options.insertImpl ?? (async () => undefined));
  jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: any) => {
    if (target === SupportAccessGrant) {
      return { find: jest.fn().mockResolvedValue(options.grants ?? []) } as any;
    }
    if (target === SupportAccessUsage) {
      return { insert } as any;
    }
    throw new Error(`Unexpected repository requested for ${String(target)}`);
  });
  return { insert };
}

function makeGuard(reflector: Reflector, registry: { resolveOwningTenantId: jest.Mock }) {
  return new RoleGuard(reflector, registry as unknown as TenantOwnershipRegistry);
}

describe('RoleGuard (T018)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes @Public() routes without checking roles', async () => {
    const guard = makeGuard(makeReflector({ isPublic: true }), {
      resolveOwningTenantId: jest.fn(),
    });
    await expect(guard.canActivate(makeContext(makeRequest()))).resolves.toBe(true);
  });

  it('passes a route with no @Roles() declared', async () => {
    const guard = makeGuard(makeReflector({}), { resolveOwningTenantId: jest.fn() });
    await expect(guard.canActivate(makeContext(makeRequest()))).resolves.toBe(true);
  });

  it('denies a caller holding none of the required roles', async () => {
    const guard = makeGuard(makeReflector({ requiredRoles: ['WorkspaceOwner'] }), {
      resolveOwningTenantId: jest.fn(),
    });
    const req = makeRequest({ roles: ['Support'] });
    await expect(guard.canActivate(makeContext(req))).rejects.toThrow(ForbiddenException);
  });

  it('allows a caller holding a non-Support required role unconditionally (no grant lookup)', async () => {
    const { insert } = mockRepos({});
    const registry = { resolveOwningTenantId: jest.fn() };
    const guard = makeGuard(makeReflector({ requiredRoles: ['BillingAdmin'] }), registry);
    const req = makeRequest({ roles: ['BillingAdmin'] });

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(registry.resolveOwningTenantId).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('allows Support with an active, unexpired, unrevoked grant and logs a non-denied usage row', async () => {
    const active = grant({ id: GRANT_ACTIVE });
    const { insert } = mockRepos({
      grants: [active, grant({ id: GRANT_EXPIRED, expiresAt: new Date(Date.now() - 1000) })],
    });
    const guard = makeGuard(makeReflector({ requiredRoles: ['Support'] }), {
      resolveOwningTenantId: jest.fn(),
    });
    const req = makeRequest({ roles: ['Support'], params: { tenantId: TENANT_A } });

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: GRANT_ACTIVE,
        usedBy: SUPPORT_USER,
        wasDenied: false,
        denialReason: null,
      }),
    );
  });

  it('denies Support with only an expired grant and logs a denial with reason "expired"', async () => {
    const expired = grant({ id: GRANT_EXPIRED, expiresAt: new Date(Date.now() - 1000) });
    const { insert } = mockRepos({ grants: [expired] });
    const guard = makeGuard(makeReflector({ requiredRoles: ['Support'] }), {
      resolveOwningTenantId: jest.fn(),
    });
    const req = makeRequest({ roles: ['Support'], params: { tenantId: TENANT_A } });

    await expect(guard.canActivate(makeContext(req))).rejects.toThrow(ForbiddenException);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: GRANT_EXPIRED, wasDenied: true, denialReason: 'expired' }),
    );
  });

  it('denies Support with only a revoked grant and logs a denial with reason "revoked"', async () => {
    const revoked = grant({ id: GRANT_REVOKED, revokedAt: new Date() });
    const { insert } = mockRepos({ grants: [revoked] });
    const guard = makeGuard(makeReflector({ requiredRoles: ['Support'] }), {
      resolveOwningTenantId: jest.fn(),
    });
    const req = makeRequest({ roles: ['Support'], params: { tenantId: TENANT_A } });

    await expect(guard.canActivate(makeContext(req))).rejects.toThrow(ForbiddenException);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: GRANT_REVOKED, wasDenied: true, denialReason: 'revoked' }),
    );
  });

  it('denies Support with no grant ever issued for the tenant, without attempting a usage write', async () => {
    const { insert } = mockRepos({ grants: [] });
    const guard = makeGuard(makeReflector({ requiredRoles: ['Support'] }), {
      resolveOwningTenantId: jest.fn(),
    });
    const req = makeRequest({ roles: ['Support'], params: { tenantId: TENANT_A } });

    await expect(guard.canActivate(makeContext(req))).rejects.toThrow(ForbiddenException);
    expect(insert).not.toHaveBeenCalled();
  });

  it('denies Support when the request carries no resolvable tenant target', async () => {
    const { insert } = mockRepos({ grants: [grant({})] });
    const guard = makeGuard(makeReflector({ requiredRoles: ['Support'] }), {
      resolveOwningTenantId: jest.fn(),
    });
    const req = makeRequest({ roles: ['Support'] });

    await expect(guard.canActivate(makeContext(req))).rejects.toThrow(ForbiddenException);
    expect(insert).not.toHaveBeenCalled();
  });

  it('fails closed with 500 when the mandatory usage write itself fails on an allowed attempt', async () => {
    const active = grant({ id: GRANT_ACTIVE });
    mockRepos({
      grants: [active],
      insertImpl: async () => {
        throw new Error('db down');
      },
    });
    const guard = makeGuard(makeReflector({ requiredRoles: ['Support'] }), {
      resolveOwningTenantId: jest.fn(),
    });
    const req = makeRequest({ roles: ['Support'], params: { tenantId: TENANT_A } });

    await expect(guard.canActivate(makeContext(req))).rejects.toThrow(InternalServerErrorException);
  });

  it('resolves the target tenant for a Support-gated ordinary resource ID via the ownership registry', async () => {
    const active = grant({ id: GRANT_ACTIVE });
    const { insert } = mockRepos({ grants: [active] });
    const registry = { resolveOwningTenantId: jest.fn().mockResolvedValue(TENANT_A) };
    const guard = makeGuard(
      makeReflector({
        requiredRoles: ['Support'],
        ownedRefs: [{ resource: 'support_access_grant', idParam: 'id' }],
      }),
      registry,
    );
    const req = makeRequest({ roles: ['Support'], params: { id: 'some-grant-id' } });

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(registry.resolveOwningTenantId).toHaveBeenCalledWith(
      'support_access_grant',
      'some-grant-id',
    );
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ grantId: GRANT_ACTIVE }));
  });
});
