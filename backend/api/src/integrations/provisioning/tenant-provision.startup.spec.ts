import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueuesModule } from '../../common/queues/queues.module';
import { AuditService } from '../../modules/audit/audit.service';
import { MinioStorageService } from '../minio/minio-storage.service';
import { OdooRpcService } from '../odoo-rpc/odoo-rpc.service';
import { TenantProvisionModule } from './tenant-provision.module';
import { TenantProvisionProcessor } from './tenant-provision.processor';

@Module({})
class NoQueuesModule {}

const credentialNames = [
  'KEMFAI_ODOO_MASTER_PASSWORD',
  'KEMFAI_TENANT_ADMIN_LOGIN',
  'KEMFAI_TENANT_ADMIN_PASSWORD',
] as const;
const fixtures = ['test-only-master', 'test-only-admin', 'test-only-password'];

describe('T044 provisioning startup fails closed', () => {
  const original = credentialNames.map((name) => process.env[name]);

  afterEach(() => {
    credentialNames.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
  });

  it.each(
    credentialNames.flatMap((name) =>
      [undefined, '', '   '].map((value) => [name, value] as const),
    ),
  )('rejects %s=%s at processor construction and module compilation', async (name, value) => {
    credentialNames.forEach((key, index) => {
      process.env[key] = fixtures[index];
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;

    expect(
      () => new TenantProvisionProcessor({} as never, {} as never, {} as never, {} as never),
    ).toThrow('Provisioning credentials are not configured');
    await expect(
      Test.createTestingModule({ imports: [TenantProvisionModule] })
        .overrideModule(QueuesModule)
        .useModule(NoQueuesModule)
        .overrideProvider(AuditService)
        .useValue({})
        .overrideProvider(MinioStorageService)
        .useValue({})
        .overrideProvider(OdooRpcService)
        .useValue({})
        .compile(),
    ).rejects.toThrow('Provisioning credentials are not configured');
  });
});
