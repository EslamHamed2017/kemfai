import { ForbiddenException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { In } from 'typeorm';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { TenantContextResolver } from '../../common/tenant-context/tenant-context.resolver';
import controlDataSource from '../../database/data-source';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { provisioningCredentials } from '../../integrations/provisioning/credentials';
import { AuditService } from '../audit/audit.service';
import { Account } from '../accounts/entities/account.entity';
import { Feature } from '../entitlements/entities/feature.entity';
import { Plan } from '../entitlements/entities/plan.entity';
import { EntitlementSet, EntitlementsService } from '../entitlements/entitlements.service';
import { Tenant } from '../tenants/entities/tenant.entity';

export interface ModuleOption {
  key: string;
  name: string;
  includedInCurrentPlan: boolean;
  requiredPlanTier: string | null;
}

export interface ModuleSelectionResult {
  featureKeys: string[];
}

interface ModuleContext {
  accountId: string;
  tenantId: string;
  keycloakUserId: string;
  database: string;
}

interface OdooSelectionReceipt {
  operationUuid: string;
  tenantId: string;
  accountId: string;
  actorKeycloakUserId: string;
  occurredAt: string;
  featureKeys: string[];
  added: string[];
  removed: string[];
}

/**
 * The control plane is authoritative for entitlement decisions; Odoo stores only the
 * tenant-local enabled-set cache. No client-supplied tenant or plan identifier is accepted.
 */
@Injectable()
export class ModuleSelectionService {
  constructor(
    private readonly tenantContext: TenantContextResolver,
    private readonly entitlements: EntitlementsService,
    private readonly odoo: OdooRpcService,
    private readonly audit: AuditService,
  ) {}

  async list(req: TenantScopedRequest): Promise<ModuleOption[]> {
    const context = await this.resolveContext(req);
    const current = await this.entitlements.getEntitlementSetForAccount(context.keycloakUserId);
    const plans = await controlDataSource
      .getRepository(Plan)
      .find({ where: { published: true }, order: { createdAt: 'ASC' } });
    const planEntitlements = await Promise.all(
      plans.map(async (plan) => ({
        plan,
        set: await this.entitlements.getEntitlementSet(plan.id),
      })),
    );

    const keys = new Set<string>();
    for (const { set } of planEntitlements) {
      for (const feature of set.features) {
        if (feature.enabled && feature.key.startsWith('module.')) keys.add(feature.key);
      }
    }
    for (const feature of current.features) {
      if (feature.enabled && feature.key.startsWith('module.')) keys.add(feature.key);
    }

    const features = keys.size
      ? await controlDataSource.getRepository(Feature).find({ where: { key: In([...keys]) } })
      : [];
    const featureByKey = new Map(features.map((feature) => [feature.key, feature]));
    const enabledCurrent = this.enabledKeys(current);

    return [...keys].sort().map((key) => {
      const feature = featureByKey.get(key);
      const requiredPlan = planEntitlements.find(({ set }) => this.enabledKeys(set).has(key))?.plan;
      return {
        key,
        name: feature?.displayNameEn?.trim() || key,
        includedInCurrentPlan: enabledCurrent.has(key),
        requiredPlanTier: enabledCurrent.has(key)
          ? null
          : requiredPlan?.nameEn?.trim() || requiredPlan?.name || null,
      };
    });
  }

  async replace(req: TenantScopedRequest, featureKeys: string[]): Promise<ModuleSelectionResult> {
    const context = await this.resolveContext(req);
    const entitlementSet = await this.entitlements.getEntitlementSetForAccount(
      context.keycloakUserId,
    );
    const entitled = this.enabledKeys(entitlementSet);
    const requested = [...new Set(featureKeys)].sort();
    const denied = requested.filter((key) => !entitled.has(key));
    if (denied.length > 0) {
      throw new ForbiddenException({
        message: 'One or more selected modules require a different plan',
        featureKeys: denied,
      });
    }

    const { login, password } = provisioningCredentials();
    const uid = await this.odoo.authenticate(context.database, login, password);
    const operationUuid = randomUUID();
    const occurredAt = new Date();
    for (let barrierCount = 0; barrierCount < 10; barrierCount += 1) {
      const persisted = await this.odoo.executeKw(
        context.database,
        uid,
        password,
        'kemfai.module.selection',
        'kemfai_replace_selection',
        [
          requested,
          operationUuid,
          context.tenantId,
          context.accountId,
          context.keycloakUserId,
          occurredAt.toISOString(),
        ],
      );
      if (!this.isReceipt(persisted)) {
        throw new InternalServerErrorException(
          'Module selection persistence returned invalid data',
        );
      }
      await this.auditAndAcknowledge(context.database, uid, password, persisted);
      if (persisted.operationUuid === operationUuid) {
        return { featureKeys: [...new Set(persisted.featureKeys)].sort() };
      }
    }
    throw new InternalServerErrorException('Module selection recovery barrier did not drain');
  }

  private async resolveContext(req: TenantScopedRequest): Promise<ModuleContext> {
    const resolved = await this.tenantContext.resolveForRequest(req);
    if (!resolved.accountId || !resolved.callerTenantId) {
      throw new InternalServerErrorException('No tenant resolved for this request');
    }
    const tenant = await controlDataSource
      .getRepository(Tenant)
      .findOneBy({ id: resolved.callerTenantId });
    if (!tenant?.odooDbName) {
      throw new InternalServerErrorException('Tenant has no provisioned Odoo database');
    }
    return {
      accountId: resolved.accountId,
      tenantId: resolved.callerTenantId,
      keycloakUserId: req.auth.keycloakUserId,
      database: tenant.odooDbName,
    };
  }

  private enabledKeys(set: EntitlementSet): Set<string> {
    return new Set(set.features.filter((feature) => feature.enabled).map((feature) => feature.key));
  }

  private isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }

  private isReceipt(value: unknown): value is OdooSelectionReceipt {
    if (!value || typeof value !== 'object') return false;
    const receipt = value as Partial<OdooSelectionReceipt>;
    return (
      typeof receipt.operationUuid === 'string' &&
      typeof receipt.tenantId === 'string' &&
      typeof receipt.accountId === 'string' &&
      typeof receipt.actorKeycloakUserId === 'string' &&
      typeof receipt.occurredAt === 'string' &&
      this.isStringArray(receipt.featureKeys) &&
      this.isStringArray(receipt.added) &&
      this.isStringArray(receipt.removed)
    );
  }

  async auditAndAcknowledge(
    database: string,
    uid: number,
    password: string,
    receipt: OdooSelectionReceipt,
  ): Promise<void> {
    if (!this.isReceipt(receipt)) {
      throw new InternalServerErrorException('Module selection persistence returned invalid data');
    }
    const tenant = await controlDataSource
      .getRepository(Tenant)
      .findOneBy({ id: receipt.tenantId });
    const account = await controlDataSource.getRepository(Account).findOneBy({
      id: receipt.accountId,
    });
    if (
      !tenant ||
      tenant.odooDbName !== database ||
      tenant.accountId !== receipt.accountId ||
      !account ||
      account.keycloakUserId !== receipt.actorKeycloakUserId
    ) {
      throw new InternalServerErrorException('Module selection receipt identity mismatch');
    }
    const receiptTime = new Date(
      /(?:Z|[+-]\d\d:\d\d)$/.test(receipt.occurredAt)
        ? receipt.occurredAt
        : `${receipt.occurredAt}Z`,
    );
    if (Number.isNaN(receiptTime.getTime())) {
      throw new InternalServerErrorException('Module selection receipt time is invalid');
    }
    await this.audit.recordModulesSelectionChanged({
      accountId: receipt.accountId,
      tenantId: receipt.tenantId,
      moduleSelectionId: receipt.tenantId,
      added: receipt.added,
      removed: receipt.removed,
      occurredAt: receiptTime,
      operationUuid: receipt.operationUuid,
    });
    const acknowledged = await this.odoo.executeKw(
      database,
      uid,
      password,
      'kemfai.module.selection',
      'kemfai_ack_selection_event',
      [receipt.operationUuid, receipt.tenantId, receipt.accountId, receipt.actorKeycloakUserId],
    );
    if (acknowledged !== true) {
      throw new InternalServerErrorException('Module selection audit receipt was not acknowledged');
    }
  }
}
