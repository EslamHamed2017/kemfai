import type { Queue } from 'bullmq';
import { TenantsService } from './tenants.service';
import { Tenant, TenantStatus } from './entities/tenant.entity';

describe('TenantsService customer status projection', () => {
  it('does not return a persisted worker diagnostic as failureReason', () => {
    const service = new TenantsService({} as Queue);
    const view = (
      service as unknown as {
        view(tenant: Tenant): { failureReason: string | null };
      }
    ).view({
      id: '10900000-0000-4000-8000-000000000003',
      status: TenantStatus.FAILED,
      failureReason: 'Odoo jsonrpc failed at /web/ for kemfai_tenant_secret using res.company',
    } as Tenant);

    expect(view.failureReason).toBe('Retry or contact support');
  });
});
