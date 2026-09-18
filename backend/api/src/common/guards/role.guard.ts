import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY, Role } from '../decorators/roles.decorator';
import { TenantScopedRequest } from '../tenant-context/tenant-context.model';
import { collectTenantReferences } from '../tenant-context/collect-tenant-references';
import { TenantOwnershipRegistry } from '../tenant-context/tenant-ownership.registry';
import controlDataSource from '../../database/data-source';
import {
  SupportAccessGrant,
  SupportAccessGranteeRole,
} from '../../modules/support-access/entities/support-access-grant.entity';
import { SupportAccessUsage } from '../../modules/support-access/entities/support-access-usage.entity';

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
  constructor(
    private readonly reflector: Reflector,
    private readonly ownershipRegistry: TenantOwnershipRegistry,
  ) {}

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
      return true;
    }

    if (requiredRoles.includes(SUPPORT_ROLE) && callerRoles.includes(SUPPORT_ROLE)) {
      await this.enforceSupportGrantScope(context, req);
      return true;
    }

    throw new ForbiddenException('Caller does not hold a role required for this endpoint');
  }

  /**
   * Resolves the tenant this request is trying to reach (same resolution TenantScopeGuard
   * uses) and requires an active `SupportAccessGrant` for it. Every attempt is logged to
   * `SupportAccessUsage` — success or denial — and the write is awaited before the guard
   * exits; on write failure the guard fails closed with 500 rather than ever serving an
   * unlogged grant or denial (mirrors TenantScopeGuard's audit fail-closed pattern, FR-041).
   */
  private async enforceSupportGrantScope(
    context: ExecutionContext,
    req: TenantScopedRequest,
  ): Promise<void> {
    const references = await collectTenantReferences(
      this.reflector,
      this.ownershipRegistry,
      context,
      req,
    );
    const target = references.find((ref) => ref.owningTenantId !== null);
    if (!target) {
      throw new ForbiddenException(
        'Support access requires a resolvable tenant target for this request',
      );
    }

    const grantRepo = controlDataSource.getRepository(SupportAccessGrant);
    const grants = await grantRepo.find({
      where: { tenantId: target.owningTenantId!, granteeRole: SupportAccessGranteeRole.SUPPORT },
      order: { createdAt: 'DESC' },
    });

    const now = Date.now();
    const activeGrant = grants.find(
      (grant) => grant.revokedAt === null && grant.expiresAt.getTime() > now,
    );
    const usedBy = req.auth!.keycloakUserId;
    const actionSummary = `${req.method} ${req.originalUrl ?? req.url}`;

    if (activeGrant) {
      await this.writeUsageOrFailClosed({
        grantId: activeGrant.id,
        usedBy,
        actionSummary,
        wasDenied: false,
        denialReason: null,
      });
      return;
    }

    // Log the denial against the most recently created grant for this tenant, if one ever
    // existed (support_access_usage.grant_id is NOT NULL — a denial with no grant to
    // attribute it to has nothing to log against, and is simply refused below).
    const mostRecentGrant = grants[0];
    if (mostRecentGrant) {
      const denialReason = mostRecentGrant.revokedAt !== null ? 'revoked' : 'expired';
      await this.writeUsageOrFailClosed({
        grantId: mostRecentGrant.id,
        usedBy,
        actionSummary,
        wasDenied: true,
        denialReason,
      });
    }

    throw new ForbiddenException('Support access denied: no active grant for this tenant');
  }

  private async writeUsageOrFailClosed(usage: {
    grantId: string;
    usedBy: string;
    actionSummary: string;
    wasDenied: boolean;
    denialReason: string | null;
  }): Promise<void> {
    const usageRepo = controlDataSource.getRepository(SupportAccessUsage);
    try {
      await usageRepo.insert(usage);
    } catch {
      throw new InternalServerErrorException(
        'Support access was evaluated but the mandatory usage record could not be written',
      );
    }
  }
}
