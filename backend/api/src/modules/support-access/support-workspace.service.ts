import { Injectable, NotFoundException } from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { Subscription } from '../billing-customer/entities/subscription.entity';
import { Tenant } from '../tenants/entities/tenant.entity';

@Injectable()
export class SupportWorkspaceService {
  async summary(tenantId: string) {
    const tenant = await controlDataSource
      .getRepository(Tenant)
      .findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Workspace not found');
    const subscription = await controlDataSource
      .getRepository(Subscription)
      .findOne({ where: { tenantId } });
    return {
      tenantId: tenant.id,
      workspaceStatus: tenant.status,
      subscriptionStatus: subscription?.status ?? null,
      billingCycle: subscription?.billingCycle ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
    };
  }
}
