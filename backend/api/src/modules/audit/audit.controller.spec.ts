import { ExecutionContext, ForbiddenException, RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { INTERNAL_ROLES, ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RoleGuard } from '../../common/guards/role.guard';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

describe('AuditController read-only authorization boundary (T092)', () => {
  const findAll = jest.fn();
  const controller = new AuditController({ findAll } as unknown as AuditService);
  const handler = AuditController.prototype.findAll;
  const populatedView = {
    id: '11111111-1111-4111-8111-111111111111',
    occurredAt: new Date('2026-10-20T13:32:31.000Z'),
    actorType: 'internal_user',
    actorId: '22222222-2222-4222-8222-222222222222',
    tenantId: '8c9c8951-9afb-4aac-a92f-f7cd728d5ffe',
    action: 'account.created',
    subjectType: 'account',
    subjectId: '33333333-3333-4333-8333-333333333333',
  };

  const contextFor = (role?: string): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => AuditController,
      switchToHttp: () => ({
        getRequest: () => ({
          auth: role ? { keycloakUserId: 'test-only', roles: [role] } : undefined,
        }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => findAll.mockReset());

  it('declares only GET /internal/audit-events and is not public', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AuditController)).toBe('internal/audit-events');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Object.getOwnPropertyNames(AuditController.prototype)).toEqual([
      'constructor',
      'findAll',
    ]);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).not.toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AuditController)).not.toBe(true);
  });

  it('allows only the baselined internal ReadOnlyManagement role', async () => {
    const guard = new RoleGuard(new Reflector());
    await expect(guard.canActivate(contextFor('ReadOnlyManagement'))).resolves.toBe(true);
    expect(Reflect.getMetadata(ROLES_KEY, AuditController)).toEqual(['ReadOnlyManagement']);
    expect(INTERNAL_ROLES).toContain('ReadOnlyManagement');
  });

  it.each([
    undefined,
    'WorkspaceOwner',
    'BillingAdmin',
    'Support',
    'SuperAdmin',
    'CustomerSuccess',
    'TechnicalAdmin',
  ])('denies a caller with role %s', async (role) => {
    const guard = new RoleGuard(new Reflector());
    await expect(guard.canActivate(contextFor(role))).rejects.toBeInstanceOf(ForbiddenException);
    expect(findAll).not.toHaveBeenCalled();
  });

  it('delegates combined tenant/action filters and returns all eight populated fields', async () => {
    const filters = {
      tenantId: '8c9c8951-9afb-4aac-a92f-f7cd728d5ffe',
      action: 'account.created',
    };
    findAll.mockResolvedValueOnce([populatedView]);

    await expect(controller.findAll(filters)).resolves.toEqual([populatedView]);
    expect(findAll).toHaveBeenCalledWith(filters);
    expect(Object.keys(populatedView)).toEqual([
      'id',
      'occurredAt',
      'actorType',
      'actorId',
      'tenantId',
      'action',
      'subjectType',
      'subjectId',
    ]);
  });
});
