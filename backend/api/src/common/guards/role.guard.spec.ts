import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleGuard } from './role.guard';
import { SUPPORT_ACCESS_ACTION_KEY } from '../decorators/support-access.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY, Role } from '../decorators/roles.decorator';

function context(roles: string[]): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => ({
        auth: { keycloakUserId: crypto.randomUUID(), roles },
        params: {},
        query: {},
        headers: {},
      }),
    }),
  } as unknown as ExecutionContext;
}
function reflector(options: { isPublic?: boolean; roles?: Role[]; action?: string }): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) =>
      key === IS_PUBLIC_KEY
        ? options.isPublic
        : key === ROLES_KEY
          ? options.roles
          : key === SUPPORT_ACCESS_ACTION_KEY
            ? options.action
            : undefined,
    ),
  } as unknown as Reflector;
}

describe('RoleGuard role boundary (T018/T089)', () => {
  it('passes public and unrestricted handlers', async () => {
    await expect(
      new RoleGuard(reflector({ isPublic: true })).canActivate(context([])),
    ).resolves.toBe(true);
    await expect(new RoleGuard(reflector({})).canActivate(context([]))).resolves.toBe(true);
  });
  it('allows a matching non-Support role and denies a mismatch', async () => {
    await expect(
      new RoleGuard(reflector({ roles: ['BillingAdmin'] })).canActivate(context(['BillingAdmin'])),
    ).resolves.toBe(true);
    await expect(
      new RoleGuard(reflector({ roles: ['BillingAdmin'] })).canActivate(context(['Support'])),
    ).rejects.toThrow(ForbiddenException);
  });
  it('never treats Support realm membership as a wildcard', async () => {
    await expect(
      new RoleGuard(reflector({ roles: ['Support'] })).canActivate(context(['Support'])),
    ).rejects.toThrow(/explicit grant-scoped action/);
  });
  it('hands only an explicitly action-scoped Support route to SupportAccessGuard', async () => {
    await expect(
      new RoleGuard(
        reflector({ roles: ['Support'], action: 'workspace.summary.read' }),
      ).canActivate(context(['Support'])),
    ).resolves.toBe(true);
    await expect(
      new RoleGuard(
        reflector({ roles: ['Support'], action: 'workspace.summary.read' }),
      ).canActivate(context(['SuperAdmin'])),
    ).rejects.toThrow(ForbiddenException);
  });
});
