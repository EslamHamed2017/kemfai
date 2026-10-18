import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import controlDataSource from '../../database/data-source';
import { SUPPORT_ACCESS_ACTION_KEY } from '../decorators/support-access.decorator';
import { TenantScopedRequest } from '../tenant-context/tenant-context.model';
import { AuditService } from '../../modules/audit/audit.service';
import { SupportAccessUsage } from '../../modules/support-access/entities/support-access-usage.entity';
import {
  SupportAccessGrant,
  SupportAccessGranteeRole,
} from '../../modules/support-access/entities/support-access-grant.entity';

const SAFE_ACTION = /^[a-z][a-z0-9]*(?:\.[a-z0-9_]+)+$/;

@Injectable()
export class SupportAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  static safeActionSummary(action: string): string {
    if (!SAFE_ACTION.test(action)) throw new ForbiddenException('Support action is not permitted');
    return action;
  }

  static validateRequestShape(input: {
    roles: string[];
    targetTenantId: string;
    grantTenantId: string;
    grantRole: string;
  }): true {
    if (
      !input.roles.includes('Support') ||
      input.grantRole !== SupportAccessGranteeRole.SUPPORT ||
      input.targetTenantId !== input.grantTenantId
    )
      throw new ForbiddenException('Support access denied');
    return true;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<string>(SUPPORT_ACCESS_ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!action) return true;
    const safeAction = SupportAccessGuard.safeActionSummary(action);
    const req = context.switchToHttp().getRequest<TenantScopedRequest>();
    const targetTenantId = req.params?.tenantId;
    const grantId = req.query?.grantId;
    if (typeof targetTenantId !== 'string' || typeof grantId !== 'string')
      throw new ForbiddenException('Explicit tenant and grant are required');

    try {
      const denied = await controlDataSource.transaction(async (manager) => {
        // Serialize evaluation with revoke and expiry transitions so an already-committed
        // revocation can never be followed by a stale-read allowed usage.
        const grant = await manager
          .getRepository(SupportAccessGrant)
          .createQueryBuilder('grant')
          .setLock('pessimistic_write')
          .where('grant.id = :grantId', { grantId })
          .getOne();
        if (!grant) throw new ForbiddenException('Support access denied');
        let denialReason: string | null = null;
        if (
          !(req.auth?.roles ?? []).includes('Support') ||
          grant.granteeRole !== SupportAccessGranteeRole.SUPPORT
        )
          denialReason = 'action_not_permitted';
        else if (grant.tenantId !== targetTenantId) denialReason = 'wrong_tenant';
        else if (grant.revokedAt) denialReason = 'revoked';
        else if (grant.expiresAt.getTime() <= Date.now()) denialReason = 'expired';
        else if (!grant.permittedActions.includes(safeAction))
          denialReason = 'action_not_permitted';
        const usage = await manager.getRepository(SupportAccessUsage).save({
          grantId: grant.id,
          usedBy: req.auth!.keycloakUserId,
          actionSummary: safeAction,
          wasDenied: denialReason !== null,
          denialReason,
        });
        void usage;
        if (denialReason) {
          await this.audit.recordSupportAccessGrantDenied(
            {
              internalUserId: req.auth!.keycloakUserId,
              tenantId: grant.tenantId,
              grantId: grant.id,
              denialReason,
            },
            manager,
          );
          return true;
        }
        await this.audit.recordSupportAccessGrantUsed(
          {
            internalUserId: req.auth!.keycloakUserId,
            tenantId: grant.tenantId,
            grantId: grant.id,
            actionSummary: safeAction,
          },
          manager,
        );
        return false;
      });
      if (denied) throw new ForbiddenException('Support access denied');
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new InternalServerErrorException('Support access evaluation could not be audited');
    }
    return true;
  }
}
