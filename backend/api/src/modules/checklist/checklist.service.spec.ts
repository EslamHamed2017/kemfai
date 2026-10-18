import controlDataSource from '../../database/data-source';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { SubscriptionStatus } from '../billing-customer/entities/subscription.entity';
import { CHECKLIST_ODOO_MODEL, ChecklistService } from './checklist.service';

jest.mock('../../database/data-source', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));

describe('ChecklistService Odoo transport', () => {
  it('keeps the model identifier in the fourth wire argument and credentials environment-derived', async () => {
    const configuredLogin = process.env.KEMFAI_TENANT_ADMIN_LOGIN!;
    const configuredPassword = process.env.KEMFAI_TENANT_ADMIN_PASSWORD!;

    const tenant = { id: 'tenant-id', accountId: 'account-id', odooDbName: 'tenant-db' };
    const getRepository = jest.mocked(controlDataSource.getRepository);
    getRepository
      .mockReturnValueOnce({ findOneBy: jest.fn().mockResolvedValue(tenant) } as never)
      .mockReturnValueOnce({
        findOneBy: jest.fn().mockResolvedValue({ status: SubscriptionStatus.ACTIVE }),
      } as never);

    const tenantContext = {
      resolveForRequest: jest.fn().mockResolvedValue({
        callerTenantId: tenant.id,
        accountId: tenant.accountId,
      }),
    };
    const odoo = {
      authenticate: jest.fn().mockResolvedValue(17),
      executeKw: jest.fn().mockResolvedValue({
        customerAdded: false,
        bankAdded: false,
        productAdded: false,
        firstInvoiceReady: false,
      }),
    };
    const service = new ChecklistService(tenantContext as never, odoo as unknown as OdooRpcService);

    await service.get({} as never);

    expect(CHECKLIST_ODOO_MODEL).toBe('kemfai.onboarding.checklist');
    expect(odoo.authenticate).toHaveBeenCalledWith(
      'tenant-db',
      configuredLogin,
      configuredPassword,
    );
    expect(odoo.executeKw).toHaveBeenCalledWith(
      'tenant-db',
      17,
      configuredPassword,
      CHECKLIST_ODOO_MODEL,
      'kemfai_get_state',
    );
    expect(odoo.executeKw.mock.calls[0][2]).not.toBe(odoo.executeKw.mock.calls[0][3]);
  });
});
