import { randomUUID } from 'crypto';
import { Job } from 'bullmq';
import { Client } from 'minio';
import controlDataSource from '../../src/database/data-source';
import { Account, BillingCycle } from '../../src/modules/accounts/entities/account.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { AuditService } from '../../src/modules/audit/audit.service';
import { MinioStorageService } from '../../src/integrations/minio/minio-storage.service';
import { createMinioClient, resolveMinioConfig } from '../../src/integrations/minio/minio-client';
import { tenantBucketName } from '../../src/integrations/minio/tenant-bucket-naming';
import { OdooRpcService } from '../../src/integrations/odoo-rpc/odoo-rpc.service';
import { createOdooRpcClient } from '../../src/integrations/odoo-rpc/odoo-rpc-client';
import { TenantProvisionProcessor } from '../../src/integrations/provisioning/tenant-provision.processor';

// The ordinary integration suite has no external-service dependency from this spec.
const live = process.env.KEMFAI_LIVE_PROVISION === '1' ? describe : describe.skip;
live('T041 physical tenant isolation (live Odoo + MinIO)', () => {
  const accounts: Account[] = [];
  let plan: Plan | undefined;
  let initialDatabases: Set<string> | undefined;
  let initialBuckets: Set<string> | undefined;
  const rpc = createOdooRpcClient();
  const odoo = new OdooRpcService(rpc);
  const minio = new Client(resolveMinioConfig());
  const objectKey = `t041/${randomUUID()}`;
  const tenants = async () => {
    const found: Tenant[] = [];
    for (const account of accounts) {
      const tenant = await controlDataSource
        .getRepository(Tenant)
        .findOneBy({ accountId: account.id });
      if (tenant) found.push(tenant);
    }
    return found;
  };

  beforeAll(async () => {
    if (!/^kemfai_t041_[a-z0-9_]+$/.test(process.env.CONTROL_DB_NAME ?? ''))
      throw new Error('T041 requires a dedicated kemfai_t041_* scratch control database');
    initialDatabases = new Set(await odoo.databaseList());
    initialBuckets = new Set((await minio.listBuckets()).map((b) => b.name));
    await controlDataSource.initialize();
    await controlDataSource.runMigrations();
    const plans = controlDataSource.getRepository(Plan);
    plan = await plans.save(
      plans.create({
        name: `t041-${randomUUID()}`,
        monthlyPrice: '0',
        annualPrice: '0',
        currency: 'USD',
        published: false,
      }),
    );
    const repo = controlDataSource.getRepository(Account);
    for (let i = 0; i < 2; i += 1)
      accounts.push(
        await repo.save(
          repo.create({
            keycloakUserId: randomUUID(),
            email: `t041-${randomUUID()}@example.com`,
            emailVerified: true,
            selectedPlanId: plan.id,
            selectedBillingCycle: BillingCycle.MONTHLY,
          }),
        ),
      );
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        errors.push(error);
      }
    };
    try {
      if (controlDataSource.isInitialized) {
        // IDs exist even when external creation succeeds but status persistence fails.
        // Snapshot guards protect anything that predated this run.
        for (const tenant of await tenants()) {
          const bucket = tenantBucketName(tenant.id);
          const db = `kemfai_tenant_${tenant.id.replace(/-/g, '')}`;
          if (initialBuckets && !initialBuckets.has(bucket))
            await attempt(async () => {
              if (await minio.bucketExists(bucket)) {
                await attempt(() => minio.removeObject(bucket, objectKey));
                await minio.removeBucket(bucket);
              }
            });
          if (initialDatabases && !initialDatabases.has(db))
            await attempt(async () => {
              if ((await odoo.databaseList()).includes(db))
                await rpc.call('db', 'drop', [process.env.KEMFAI_ODOO_MASTER_PASSWORD, db]);
            });
          await attempt(async () => {
            await controlDataSource.query('DELETE FROM audit_event WHERE tenant_id = $1', [
              tenant.id,
            ]);
            await controlDataSource.query('DELETE FROM subscription WHERE tenant_id = $1', [
              tenant.id,
            ]);
            await controlDataSource.query('DELETE FROM tenant WHERE id = $1', [tenant.id]);
          });
        }
        for (const account of accounts)
          await attempt(() =>
            controlDataSource.query('DELETE FROM account WHERE id = $1', [account.id]),
          );
        if (plan) {
          const planId = plan.id;
          await attempt(() => controlDataSource.query('DELETE FROM plan WHERE id = $1', [planId]));
        }
      }
    } finally {
      if (controlDataSource.isInitialized) await controlDataSource.destroy();
    }
    if (errors.length)
      throw new Error(
        `T041 cleanup failed in ${errors.length} operation(s); inspect scratch resources`,
      );
  });

  it('provisions two verified accounts and verifies distinct physical resources and isolated writes', async () => {
    const processor = new TenantProvisionProcessor(
      new AuditService(),
      new MinioStorageService(createMinioClient()),
      odoo,
    );
    for (const account of accounts)
      await processor.process({ data: { accountId: account.id } } as Job<{ accountId: string }>);
    const [a, b] = await tenants();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect([a.accountId, b.accountId]).toEqual(accounts.map((account) => account.id));
    expect(a.id).not.toBe(b.id);
    for (const tenant of [a, b]) {
      expect(tenant.status).toBe(TenantStatus.READY);
      expect(tenant.odooDbName).toBe(`kemfai_tenant_${tenant.id.replace(/-/g, '')}`);
      expect(tenant.minioBucket).toBe(tenantBucketName(tenant.id));
    }
    expect(a.odooDbName).not.toBe(b.odooDbName);
    expect(a.minioBucket).not.toBe(b.minioBucket);
    const dbNames = await odoo.databaseList();
    const bucketNames = (await minio.listBuckets()).map((bucket) => bucket.name);
    for (const tenant of [a, b]) {
      expect(dbNames.filter((name) => name === tenant.odooDbName)).toHaveLength(1);
      expect(bucketNames.filter((name) => name === tenant.minioBucket)).toHaveLength(1);
      expect(initialDatabases?.has(tenant.odooDbName!)).toBe(false);
      expect(initialBuckets?.has(tenant.minioBucket!)).toBe(false);
    }
    const password = process.env.KEMFAI_TENANT_ADMIN_PASSWORD!;
    const uids = await Promise.all(
      [a, b].map((t) =>
        odoo.authenticate(t.odooDbName!, process.env.KEMFAI_TENANT_ADMIN_LOGIN!, password),
      ),
    );
    const key = `t041.isolation.${randomUUID()}`;
    const values = [randomUUID(), randomUUID()];
    for (let i = 0; i < 2; i += 1)
      await odoo.executeKw(
        [a, b][i].odooDbName!,
        uids[i],
        password,
        'ir.config_parameter',
        'set_param',
        [key, values[i]],
      );
    for (let i = 0; i < 2; i += 1)
      expect(
        await odoo.executeKw(
          [a, b][i].odooDbName!,
          uids[i],
          password,
          'ir.config_parameter',
          'get_param',
          [key],
        ),
      ).toBe(values[i]);
    for (let i = 0; i < 2; i += 1)
      await minio.putObject([a, b][i].minioBucket!, objectKey, Buffer.from(values[i]));
    for (let i = 0; i < 2; i += 1) {
      const stream = await minio.getObject([a, b][i].minioBucket!, objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe(values[i]);
    }
    console.log('T041 physical evidence', {
      accountIds: accounts.map((account) => account.id),
      tenantIds: [a.id, b.id],
      odooDatabases: [a.odooDbName, b.odooDbName],
      minioBuckets: [a.minioBucket, b.minioBucket],
      isolatedOdooParameter: key,
      isolatedMinioObject: objectKey,
    });
  }, 360000);
});
