import { randomUUID } from 'crypto';
import { Client } from 'minio';
import { Job } from 'bullmq';
import controlDataSource from '../../src/database/data-source';
import { Account, BillingCycle } from '../../src/modules/accounts/entities/account.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { Subscription } from '../../src/modules/billing-customer/entities/subscription.entity';
import { AuditService } from '../../src/modules/audit/audit.service';
import { MinioStorageService } from '../../src/integrations/minio/minio-storage.service';
import { createMinioClient, resolveMinioConfig } from '../../src/integrations/minio/minio-client';
import { OdooRpcService } from '../../src/integrations/odoo-rpc/odoo-rpc.service';
import { createOdooRpcClient } from '../../src/integrations/odoo-rpc/odoo-rpc-client';
import { TenantProvisionProcessor } from '../../src/integrations/provisioning/tenant-provision.processor';

const live = process.env.KEMFAI_LIVE_PROVISION === '1' ? describe : describe.skip;
live('T044 live provisioning against real Postgres, MinIO and Odoo', () => {
  let account: Account;
  let plan: Plan;
  let bucket: string | undefined;
  let db: string | undefined;
  const client = createOdooRpcClient();
  const odoo = new OdooRpcService(client);
  const minio = new Client(resolveMinioConfig());
  beforeAll(async () => {
    if (!controlDataSource.isInitialized) await controlDataSource.initialize();
    await controlDataSource.runMigrations();
    const repo = controlDataSource.getRepository(Plan);
    plan = await repo.save(
      repo.create({
        name: `t044-${randomUUID()}`,
        monthlyPrice: '0',
        annualPrice: '0',
        currency: 'USD',
        published: false,
      }),
    );
    const accounts = controlDataSource.getRepository(Account);
    account = await accounts.save(
      accounts.create({
        keycloakUserId: randomUUID(),
        email: `t044-${randomUUID()}@example.com`,
        emailVerified: true,
        selectedPlanId: plan.id,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
    );
  });
  afterAll(async () => {
    try {
      if (account) {
        const t = await controlDataSource
          .getRepository(Tenant)
          .findOneBy({ accountId: account.id });
        if (t) {
          bucket = t.minioBucket ?? undefined;
          db = t.odooDbName ?? `kemfai_tenant_${t.id.replace(/-/g, '')}`;
          await controlDataSource.query('DELETE FROM audit_event WHERE tenant_id = $1', [t.id]);
          await controlDataSource.query('DELETE FROM subscription WHERE tenant_id = $1', [t.id]);
          await controlDataSource.query('DELETE FROM tenant WHERE id = $1', [t.id]);
        }
        await controlDataSource.query('DELETE FROM account WHERE id = $1', [account.id]);
      }
      if (plan) await controlDataSource.query('DELETE FROM plan WHERE id = $1', [plan.id]);
      if (bucket && (await minio.bucketExists(bucket))) await minio.removeBucket(bucket);
      if (db && (await odoo.databaseList()).includes(db))
        await client.call('db', 'drop', [process.env.KEMFAI_ODOO_MASTER_PASSWORD, db]);
    } finally {
      if (controlDataSource.isInitialized) await controlDataSource.destroy();
    }
  });
  it('concurrent jobs and retry converge on exactly one tenant, subscription, bucket, database and company', async () => {
    const processor = new TenantProvisionProcessor(
      new AuditService(),
      new MinioStorageService(createMinioClient()),
      odoo,
    );
    const job = { data: { accountId: account.id } } as Job<{ accountId: string }>;
    await Promise.all([processor.process(job), processor.process(job)]);
    const t = await controlDataSource
      .getRepository(Tenant)
      .findOneByOrFail({ accountId: account.id });
    bucket = t.minioBucket ?? undefined;
    db = t.odooDbName ?? undefined;
    expect(t.status).toBe(TenantStatus.READY);
    expect(await minio.bucketExists(bucket!)).toBe(true);
    expect(await odoo.databaseList()).toContain(db);
    const uid = await odoo.authenticate(
      db!,
      process.env.KEMFAI_TENANT_ADMIN_LOGIN!,
      process.env.KEMFAI_TENANT_ADMIN_PASSWORD!,
    );
    expect(
      await odoo.executeKw(
        db!,
        uid,
        process.env.KEMFAI_TENANT_ADMIN_PASSWORD!,
        'res.company',
        'search_count',
        [[]],
      ),
    ).toBe(1);
    await processor.process(job);
    expect(await controlDataSource.getRepository(Tenant).countBy({ accountId: account.id })).toBe(
      1,
    );
    expect(await controlDataSource.getRepository(Subscription).countBy({ tenantId: t.id })).toBe(1);
  }, 180000);
});
