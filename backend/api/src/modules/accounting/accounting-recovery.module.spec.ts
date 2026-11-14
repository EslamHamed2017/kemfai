import 'reflect-metadata';
import { Job } from 'bullmq';
import { AppModule } from '../../app.module';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { AccountingMutationRecoveryService } from './accounting-mutation-recovery.service';
import {
  AccountingMutationRecoveryProcessor,
  AccountingRecoveryModule,
  AccountingRecoveryOdooAdapter,
} from './accounting-recovery.module';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

describe('AccountingRecoveryModule (T037)', () => {
  it('is imported by the production AppModule independently of request modules', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(imports).toContain(AccountingRecoveryModule);
  });

  it('runs exactly one recovery tick for the fixed BullMQ job and ignores foreign names', async () => {
    const recoverOnce = jest.fn().mockResolvedValue({ recovered: 1, retryable: 0 });
    const processor = new AccountingMutationRecoveryProcessor({
      recoverOnce,
    } as unknown as AccountingMutationRecoveryService);
    await processor.process({ name: 'foreign' } as Job);
    expect(recoverOnce).not.toHaveBeenCalled();
    await processor.process({ name: 'recover' } as Job);
    expect(recoverOnce).toHaveBeenCalledTimes(1);
  });

  it('authenticates at execution time with configured credentials and returns only object results', async () => {
    process.env.KEMFAI_ODOO_MASTER_PASSWORD = 'master';
    process.env.KEMFAI_TENANT_ADMIN_LOGIN = 'admin';
    process.env.KEMFAI_TENANT_ADMIN_PASSWORD = 'secret';
    const authenticate = jest.fn().mockResolvedValue(7);
    const executeKw = jest.fn().mockResolvedValue({ id: 'result-id', version: 1 });
    const adapter = new AccountingRecoveryOdooAdapter({
      authenticate,
      executeKw,
    } as unknown as OdooRpcService);
    await expect(
      adapter.executeKw(
        { db: 'tenant-a', companyId: 42 },
        'account.account',
        'kemfai_create_account',
        ['operation-id'],
        {},
      ),
    ).resolves.toEqual({ id: 'result-id', version: 1 });
    expect(authenticate).toHaveBeenCalledWith('tenant-a', 'admin', 'secret');
    expect(executeKw).toHaveBeenCalledWith(
      'tenant-a',
      7,
      'secret',
      'account.account',
      'kemfai_create_account',
      ['operation-id'],
      { context: { allowed_company_ids: [42], force_company: 42 } },
    );
  });
});
