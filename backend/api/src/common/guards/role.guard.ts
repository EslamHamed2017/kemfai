import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY, Role } from '../decorators/roles.decorator';
import { TenantScopedRequest } from '../tenant-context/tenant-context.model';
import { requireReadyWorkspaceOwner } from './workspace-owner-access';
import { SUPPORT_ACCESS_ACTION_KEY } from '../decorators/support-access.decorator';

const SUPPORT_ROLE: Role = 'Support';

/**
 * Global role enforcement (T018, data-model.md "Cross-cutting: Roles & Scopes"). Registered
 * once via APP_GUARD in AppModule, after BearerAuthGuard and TenantScopeGuard — never
 * per-endpoint — so a single implementation authorizes both UI-driven and raw HTTP calls
 * identically (FR-006). A handler with no `@Roles()` is not role-restricted by this guard.
 *
 * Most roles in the table are unconditional once the caller holds them (Workspace Owner is
 * already confined to its own tenant by TenantScopeGuard; BillingAdmin/SuperAdmin/
 * CustomerSuccess/TechnicalAdmin are cross-tenant by design). `Support` is the one role whose
 * scope is narrower than "holds the realm role": the table restricts it to "tenants with an
 * active, unexpired, unrevoked grant" (FR-005), and every attempt — granted or denied — must
 * write a `SupportAccessUsage` row (FR-041). Both are enforced here so no endpoint can grant
 * Support-role access by realm-role membership alone.
 */
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controllerClass = context.getClass();

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controllerClass])) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      handler,
      controllerClass,
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<TenantScopedRequest>();
    const callerRoles = req.auth?.roles ?? [];

    const nonSupportMatch = requiredRoles.some(
      (role) => role !== SUPPORT_ROLE && callerRoles.includes(role),
    );
    if (nonSupportMatch) {
      if (
        requiredRoles.includes('WorkspaceOwner') &&
        callerRoles.includes('WorkspaceOwner') &&
        !requiredRoles.some(
          (role) =>
            role !== 'WorkspaceOwner' && role !== SUPPORT_ROLE && callerRoles.includes(role),
        )
      ) {
        await requireReadyWorkspaceOwner(req);
      }
      return true;
    }

    if (requiredRoles.includes(SUPPORT_ROLE) && callerRoles.includes(SUPPORT_ROLE)) {
      const action = this.reflector.getAllAndOverride<string>(SUPPORT_ACCESS_ACTION_KEY, [
        handler,
        controllerClass,
      ]);
      if (action) return true;
      throw new ForbiddenException('Support endpoints require an explicit grant-scoped action');
    }

    throw new ForbiddenException('Caller does not hold a role required for this endpoint');
  }
}
