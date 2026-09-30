import { randomUUID } from 'crypto';
import controlDataSource from '../../src/database/data-source';
import { TenantProvisionProcessor } from '../../src/integrations/provisioning/tenant-provision.processor';
import { AuditService } from '../../src/modules/audit/audit.service';
import { Account, BillingCycle } from '../../src/modules/accounts/entities/account.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { Subscription } from '../../src/modules/billing-customer/entities/subscription.entity';
import { AuditEvent } from '../../src/modules/audit/entities/audit-event.entity';
import { MinioStorageService } from '../../src/integrations/minio/minio-storage.service';
import { OdooRpcService } from '../../src/integrations/odoo-rpc/odoo-rpc.service';
import { Job } from 'bullmq';

// Real control Postgres; fake external APIs let failure injection prove recovery and ordering.
describe('tenant provisioning control-plane transactions (T044)', () => {
  let account: Account;
  let plan: Plan;
  let processor: TenantProvisionProcessor;
  let audit: AuditService;
  const buckets = new Set<string>();
  const databases = new Set<string>();
  const calls: string[] = [];
  let failAt: string | undefined;
  let failAudit = false;
  let failSuccessAudit = false;
  const fail = (step: string) => {
    calls.push(step);
    if (failAt === step) {
      failAt = undefined;
      throw new Error('private-secret-example');
    }
  };
  const storage = {
    createTenantBucket: jest.fn(async (id: string) => {
      fail('bucket');
      const name = `kemfai-tenant-${id}`;
      buckets.add(name);
      fail('bucket-complete');
      return name;
    }),
    bucketExists: jest.fn(async (bucket: string) => buckets.has(bucket)),
  };
  const odoo = {
    databaseList: jest.fn(async () => [...databases]),
    createDatabase: jest.fn(async (_master: string, name: string) => {
      fail('database');
      databases.add(name);
      fail('database-complete');
    }),
    authenticate: jest.fn(async () => 2),
    executeKw: jest.fn(
      async (_db: string, _uid: number, _pass: string, model: string, method: string) => {
        if (model === 'res.company') {
          fail('company');
          return 1;
        }
        if (method === 'button_immediate_install') {
          fail('addon');
          return true;
        }
        fail('addon-list');
        return [
          'kemfai_tenant_core',
          'kemfai_company_setup',
          'kemfai_module_selection',
          'kemfai_onboarding_checklist',
        ].map((name, index) => ({ id: index + 1, name, state: 'installed' }));
      },
    ),
  };
  const run = () =>
    processor.process({ data: { accountId: account.id } } as Job<{ accountId: string }>);
  const tenant = async () =>
    controlDataSource.getRepository(Tenant).findOneByOrFail({ accountId: account.id });
  const events = async () =>
    controlDataSource
      .getRepository(AuditEvent)
      .find({ where: { tenantId: (await tenant()).id }, order: { createdAt: 'ASC' } });

  beforeAll(async () => {
    process.env.KEMFAI_ODOO_MASTER_PASSWORD = 'test-master';
    process.env.KEMFAI_TENANT_ADMIN_LOGIN = 'test-admin';
    process.env.KEMFAI_TENANT_ADMIN_PASSWORD = 'test-password';
    if (!controlDataSource.isInitialized) await controlDataSource.initialize();
    await controlDataSource.runMigrations();
  });
  beforeEach(async () => {
    failAt = undefined;
    failAudit = false;
    failSuccessAudit = false;
    calls.length = 0;
    buckets.clear();
    databases.clear();
    const repo = controlDataSource.getRepository(Plan);
    plan = await repo.save(
      repo.create({
        name: `test-${randomUUID()}`,
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
        email: `test-${randomUUID()}@example.com`,
        emailVerified: true,
        selectedPlanId: plan.id,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
    );
    audit = new AuditService();
    const original = audit.recordTenantProvisioningAttempted.bind(audit);
    jest
      .spyOn(audit, 'recordTenantProvisioningAttempted')
      .mockImplementation(async (event, manager) => {
        if (failAudit) {
          failAudit = false;
          throw new Error('audit secret');
        }
        return original(event, manager);
      });
    const originalSuccess = audit.recordTenantProvisioningSucceeded.bind(audit);
    jest
      .spyOn(audit, 'recordTenantProvisioningSucceeded')
      .mockImplementation(async (event, manager) => {
        if (failSuccessAudit) {
          failSuccessAudit = false;
          throw new Error('audit success secret');
        }
        return originalSuccess(event, manager);
      });
    processor = new TenantProvisionProcessor(
      audit,
      storage as unknown as MinioStorageService,
      odoo as unknown as OdooRpcService,
    );
  });
  afterEach(async () => {
    const existing = await controlDataSource
      .getRepository(Tenant)
      .findOneBy({ accountId: account.id });
    if (existing) {
      await controlDataSource.query('DELETE FROM audit_event WHERE tenant_id = $1', [existing.id]);
      await controlDataSource.query('DELETE FROM subscription WHERE tenant_id = $1', [existing.id]);
      await controlDataSource.query('DELETE FROM tenant WHERE id = $1', [existing.id]);
    }
    await controlDataSource.query('DELETE FROM account WHERE id = $1', [account.id]);
    await controlDataSource.query('DELETE FROM plan WHERE id = $1', [plan.id]);
    jest.clearAllMocks();
  });
  afterAll(async () => {
    if (controlDataSource.isInitialized) await controlDataSource.destroy();
  });

  it('serializes two concurrent jobs, one tenant/subscription/bucket/database/company and ordered lifecycle', async () => {
    await Promise.all([run(), run()]);
    const current = await tenant();
    expect(current.status).toBe(TenantStatus.READY);
    expect(current.provisioningAttempts).toBe(1);
    expect(await controlDataSource.getRepository(Tenant).countBy({ accountId: account.id })).toBe(
      1,
    );
    expect(
      await controlDataSource.getRepository(Subscription).countBy({ tenantId: current.id }),
    ).toBe(1);
    expect(buckets.size).toBe(1);
    expect(databases.size).toBe(1);
    expect(calls.filter((step) => step === 'company')).toHaveLength(1);
    expect((await events()).map((event) => event.action)).toEqual([
      'tenant.provisioning.attempted',
      'tenant.provisioning.succeeded',
    ]);
    expect((await events())[0].payload.attempt_number).toBe(1);
  });
  it.each(['bucket', 'bucket-complete', 'database', 'addon-list', 'company'])(
    'recovers on retry after %s failure',
    async (step) => {
      failAt = step;
      await expect(run()).rejects.toThrow('Tenant provisioning failed');
      expect((await tenant()).status).toBe(TenantStatus.FAILED);
      expect((await tenant()).failureReason).not.toContain('private-secret');
      await run();
      expect((await tenant()).status).toBe(TenantStatus.READY);
      expect((await events()).map((event) => event.action)).toEqual([
        'tenant.provisioning.attempted',
        'tenant.provisioning.failed',
        'tenant.provisioning.attempted',
        'tenant.provisioning.succeeded',
      ]);
    },
  );
  it('treats an Odoo already-created database error as success after verification', async () => {
    failAt = 'database-complete';
    await run();
    expect((await tenant()).status).toBe(TenantStatus.READY);
    expect(databases.size).toBe(1);
  });
  it('rolls back Ready and Subscription when success audit fails, then retries safely', async () => {
    failSuccessAudit = true;
    await expect(run()).rejects.toThrow('Tenant provisioning failed');
    const current = await tenant();
    expect(current.status).toBe(TenantStatus.FAILED);
    expect(current.readyAt).toBeNull();
    expect(
      await controlDataSource.getRepository(Subscription).countBy({ tenantId: current.id }),
    ).toBe(0);
    expect((await events()).map((event) => event.action)).toEqual([
      'tenant.provisioning.attempted',
      'tenant.provisioning.failed',
    ]);
    await run();
    expect((await tenant()).status).toBe(TenantStatus.READY);
  });
  it('rolls back failed attempted audit and commits Failed with a failed event', async () => {
    failAudit = true;
    await expect(run()).rejects.toThrow('Tenant provisioning failed');
    expect((await tenant()).status).toBe(TenantStatus.FAILED);
    expect((await tenant()).provisioningAttempts).toBe(0);
    expect((await events()).map((event) => event.action)).toEqual(['tenant.provisioning.failed']);
  });
});
