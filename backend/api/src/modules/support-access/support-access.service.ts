import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { TenantContextResolver } from '../../common/tenant-context/tenant-context.resolver';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { AuditService } from '../audit/audit.service';
import { Account } from '../accounts/entities/account.entity';
import { SupportAccessUsage } from './entities/support-access-usage.entity';
import {
  SUPPORT_WORKSPACE_SUMMARY_ACTION,
  SupportAccessGrant,
  SupportAccessGranteeRole,
  SupportAccessGrantStatus,
} from './entities/support-access-grant.entity';
import { CreateSupportAccessGrantDto } from './dto/create-support-access-grant.dto';

export interface SupportAccessUsageView {
  id: string;
  usedBy: string;
  usedAt: string;
  actionSummary: string;
  wasDenied: boolean;
  denialReason: string | null;
}
export interface SupportAccessGrantView {
  id: string;
  granteeRole: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  expiredAt: string | null;
  status: 'active' | 'expired' | 'revoked';
  permittedActions: string[];
  usage: SupportAccessUsageView[];
}

@Injectable()
export class SupportAccessService {
  constructor(
    private readonly tenantContext: TenantContextResolver,
    private readonly audit: AuditService,
  ) {}

  validateExpiry(value: string, now = new Date()): Date {
    const expiry = new Date(value);
    const configuredValue = process.env.SUPPORT_ACCESS_MAX_DURATION_HOURS;
    const maxHours = Number(configuredValue);
    if (!configuredValue || !Number.isFinite(maxHours) || maxHours <= 0)
      throw new InternalServerErrorException('Support access maximum duration is not configured');
    if (
      !Number.isFinite(expiry.getTime()) ||
      expiry.getTime() <= now.getTime() ||
      expiry.getTime() > now.getTime() + maxHours * 60 * 60 * 1000
    ) {
      throw new UnprocessableEntityException(
        `Expiry must be in the future and within ${maxHours} hours`,
      );
    }
    return expiry;
  }

  assertRevocable(grant: SupportAccessGrant, now = new Date()): void {
    if (
      grant.status !== SupportAccessGrantStatus.ACTIVE ||
      grant.revokedAt ||
      grant.expiresAt.getTime() <= now.getTime()
    )
      throw new ConflictException('Grant is not active');
  }

  async list(req: TenantScopedRequest): Promise<SupportAccessGrantView[]> {
    const { callerTenantId } = await this.tenantContext.resolveForRequest(req);
    if (!callerTenantId) throw new NotFoundException('Workspace not found');
    const grants = await controlDataSource.getRepository(SupportAccessGrant).find({
      where: { tenantId: callerTenantId },
      order: { createdAt: 'DESC' },
    });
    const usages = grants.length
      ? await controlDataSource
          .getRepository(SupportAccessUsage)
          .createQueryBuilder('usage')
          .where('usage.grant_id IN (:...ids)', { ids: grants.map((g) => g.id) })
          .orderBy('usage.used_at', 'DESC')
          .getMany()
      : [];
    return grants.map((grant) =>
      this.view(
        grant,
        usages.filter((usage) => usage.grantId === grant.id),
      ),
    );
  }

  async create(
    req: TenantScopedRequest,
    input: CreateSupportAccessGrantDto,
  ): Promise<SupportAccessGrantView> {
    const context = await this.tenantContext.resolveForRequest(req);
    if (!context.callerTenantId || !context.accountId)
      throw new NotFoundException('Workspace not found');
    const expiry = this.validateExpiry(input.expiresAt);
    return controlDataSource.transaction(async (manager) => {
      const account = await manager.getRepository(Account).findOneBy({ id: context.accountId! });
      if (!account?.emailVerified)
        throw new UnprocessableEntityException('Verified owner required');
      const grant = await manager.getRepository(SupportAccessGrant).save({
        tenantId: context.callerTenantId!,
        grantedBy: context.accountId!,
        granteeRole: SupportAccessGranteeRole.SUPPORT,
        permittedActions: [SUPPORT_WORKSPACE_SUMMARY_ACTION],
        expiresAt: expiry,
        revokedAt: null,
        expiredAt: null,
        status: SupportAccessGrantStatus.ACTIVE,
      });
      await this.audit.recordSupportAccessGrantCreated(
        {
          accountId: context.accountId!,
          tenantId: context.callerTenantId!,
          grantId: grant.id,
          granteeRole: grant.granteeRole,
          expiresAt: expiry,
        },
        manager,
      );
      return this.view(grant, []);
    });
  }

  async revoke(req: TenantScopedRequest, grantId: string): Promise<SupportAccessGrantView> {
    const context = await this.tenantContext.resolveForRequest(req);
    if (!context.callerTenantId || !context.accountId)
      throw new NotFoundException('Grant not found');
    return controlDataSource.transaction(async (manager) => {
      const grant = await manager
        .getRepository(SupportAccessGrant)
        .createQueryBuilder('grant')
        .setLock('pessimistic_write')
        .where('grant.id = :grantId AND grant.tenant_id = :tenantId', {
          grantId,
          tenantId: context.callerTenantId,
        })
        .getOne();
      if (!grant) throw new NotFoundException('Grant not found');
      this.assertRevocable(grant);
      const revokedAt = new Date();
      grant.revokedAt = revokedAt;
      grant.status = SupportAccessGrantStatus.REVOKED;
      await manager.getRepository(SupportAccessGrant).save(grant);
      await this.audit.recordSupportAccessGrantRevoked(
        {
          accountId: context.accountId!,
          tenantId: context.callerTenantId!,
          grantId,
          revokedBy: context.accountId!,
          occurredAt: revokedAt,
        },
        manager,
      );
      const usage = await manager
        .getRepository(SupportAccessUsage)
        .find({ where: { grantId }, order: { usedAt: 'DESC' } });
      return this.view(grant, usage);
    });
  }

  private view(grant: SupportAccessGrant, usage: SupportAccessUsage[]): SupportAccessGrantView {
    const effectiveStatus = grant.revokedAt
      ? 'revoked'
      : grant.expiredAt || grant.expiresAt.getTime() <= Date.now()
        ? 'expired'
        : 'active';
    return {
      id: grant.id,
      granteeRole: grant.granteeRole,
      grantedBy: grant.grantedBy,
      grantedAt: grant.createdAt.toISOString(),
      expiresAt: grant.expiresAt.toISOString(),
      revokedAt: grant.revokedAt?.toISOString() ?? null,
      expiredAt: grant.expiredAt?.toISOString() ?? null,
      status: effectiveStatus,
      permittedActions: grant.permittedActions,
      usage: usage.map((row) => ({
        id: row.id,
        usedBy: row.usedBy,
        usedAt: row.usedAt.toISOString(),
        actionSummary: row.actionSummary,
        wasDenied: row.wasDenied,
        denialReason: row.denialReason,
      })),
    };
  }
}
