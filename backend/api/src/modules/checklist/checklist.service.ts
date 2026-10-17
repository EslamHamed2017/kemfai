import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { TenantContextResolver } from '../../common/tenant-context/tenant-context.resolver';
import controlDataSource from '../../database/data-source';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { provisioningCredentials } from '../../integrations/provisioning/credentials';
import { Subscription, SubscriptionStatus } from '../billing-customer/entities/subscription.entity';
import { Tenant } from '../tenants/entities/tenant.entity';

export interface ChecklistState {
  customerAdded: boolean;
  bankAdded: boolean;
  productAdded: boolean;
  firstInvoiceReady: boolean;
  gatedOnSubscriptionActivation: boolean;
}

type Readiness = Omit<ChecklistState, 'gatedOnSubscriptionActivation'>;

@Injectable()
export class ChecklistService {
  constructor(
    private readonly tenantContext: TenantContextResolver,
    private readonly odoo: OdooRpcService,
  ) {}

  async get(req: TenantScopedRequest): Promise<ChecklistState> {
    const context = await this.tenantContext.resolveForRequest(req);
    if (!context.callerTenantId || !context.accountId) {
      throw new InternalServerErrorException('No tenant resolved for this request');
    }
    const tenant = await controlDataSource.getRepository(Tenant).findOneBy({
      id: context.callerTenantId,
      accountId: context.accountId,
    });
    if (!tenant?.odooDbName) {
      throw new InternalServerErrorException('Tenant has no provisioned Odoo database');
    }
    const { login, password } = provisioningCredentials();
    const uid = await this.odoo.authenticate(tenant.odooDbName, login, password);
    const value = await this.odoo.executeKw(
      tenant.odooDbName,
      uid,
      password,
      'kemfai.onboarding.checklist',
      'kemfai_get_state',
    );
    if (!this.isReadiness(value)) {
      throw new InternalServerErrorException('Checklist readiness returned invalid data');
    }
    const subscription = await controlDataSource.getRepository(Subscription).findOneBy({
      tenantId: tenant.id,
    });
    return {
      ...value,
      gatedOnSubscriptionActivation: subscription?.status !== SubscriptionStatus.ACTIVE,
    };
  }

  private isReadiness(value: unknown): value is Readiness {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    const keys = ['customerAdded', 'bankAdded', 'productAdded', 'firstInvoiceReady'];
    return (
      Object.keys(row).length === keys.length && keys.every((key) => typeof row[key] === 'boolean')
    );
  }
}
