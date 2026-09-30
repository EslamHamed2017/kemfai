import { randomUUID } from 'crypto';
import { Controller, Get, INestApplication, Module, Param } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import { Roles } from '../../src/common/decorators/roles.decorator';
import { startFakeKeycloak } from '../support/fake-keycloak';
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
import { Job, Queue } from 'bullmq';
import { getQueueToken } from '@nestjs/bullmq';
import { KEYCLOAK_USER_PROVISIONER } from '../../src/integrations/keycloak/keycloak-user-provisioner';
import { FakeKeycloakUsers } from '../support/fake-keycloak-users';
import { QUEUE_EMAIL_SEND_VERIFICATION } from '../../src/common/queues/queue-names';

@Controller('t046-probe')
class OwnerProbe {
  @Get('scope-only/tenants/:tenantId')
  scopeOnly(@Param('tenantId') tenantId: string): { tenantId: string } {
    return { tenantId };
  }

  @Get('tenants/:tenantId')
  @Roles('WorkspaceOwner')
  owner(@Param('tenantId') tenantId: string): { tenantId: string } {
    return { tenantId };
  }
}
@Module({ controllers: [OwnerProbe] })
class OwnerProbeModule {}

// Real control Postgres; fake external APIs let failure injection prove recovery and ordering.
describe('tenant provisioning control-plane transactions (T044)', () => {
  let account: Account;
  let plan: Plan;
  let processor: TenantProvisionProcessor;
  let audit: AuditService;
  const bindings = new Map<string, string>();
  const keycloak = {
    assignWorkspaceOwner: jest.fn(async (id: string, tenantId: string) => {
      fail('owner');
      bindings.set(id, tenantId);
      fail('owner-complete');
    }),
    revokeWorkspaceOwner: jest.fn(async (id: string) => {
      if (failRevoke) {
        failRevoke = false;
        throw new Error('private-revoke-secret');
      }
      bindings.delete(id);
    }),
  };
  const buckets = new Set<string>();
  const databases = new Set<string>();
  const calls: string[] = [];
  let failAt: string | undefined;
  let failAudit = false;
  let failSuccessAudit = false;
  let failRevoke = false;
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
    failRevoke = false;
    calls.length = 0;
    buckets.clear();
    databases.clear();
    bindings.clear();
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
      keycloak as never,
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

  const CONCURRENCY = 5;
  const SEQUENTIAL_RETRIES = 5;

  it(`serializes ${CONCURRENCY} concurrent jobs then ${SEQUENTIAL_RETRIES} sequential retries into one tenant/subscription/bucket/database/company and ordered lifecycle`, async () => {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => run()));
    const current = await tenant();
    expect(current.status).toBe(TenantStatus.READY);
    expect(bindings.get(account.keycloakUserId)).toBe(current.id);
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

    // N sequential retries of the already-Ready request must remain no-ops: no new
    // tenant/subscription/bucket/database/company and no additional lifecycle audit events.
    bindings.clear(); // Simulate a lost remote mapping; Ready must repair it.
    for (let i = 0; i < SEQUENTIAL_RETRIES; i += 1) {
      await run();
    }
    const afterRetries = await tenant();
    expect(bindings.get(account.keycloakUserId)).toBe(afterRetries.id);
    expect(keycloak.assignWorkspaceOwner).toHaveBeenCalledTimes(CONCURRENCY + SEQUENTIAL_RETRIES);
    expect(afterRetries.status).toBe(TenantStatus.READY);
    expect(afterRetries.provisioningAttempts).toBe(1);
    expect(await controlDataSource.getRepository(Tenant).countBy({ accountId: account.id })).toBe(
      1,
    );
    expect(
      await controlDataSource.getRepository(Subscription).countBy({ tenantId: afterRetries.id }),
    ).toBe(1);
    expect(buckets.size).toBe(1);
    expect(databases.size).toBe(1);
    expect(calls.filter((step) => step === 'company')).toHaveLength(1);
    expect((await events()).map((event) => event.action)).toEqual([
      'tenant.provisioning.attempted',
      'tenant.provisioning.succeeded',
    ]);
  });
  it.each([
    'bucket',
    'bucket-complete',
    'database',
    'addon-list',
    'company',
    'owner',
    'owner-complete',
  ])('recovers on retry after %s failure', async (step) => {
    failAt = step;
    await expect(run()).rejects.toThrow('Tenant provisioning failed');
    expect((await tenant()).status).toBe(TenantStatus.FAILED);
    expect(bindings.has(account.keycloakUserId)).toBe(false);
    expect((await tenant()).failureReason).not.toContain('private-secret');
    await run();
    expect((await tenant()).status).toBe(TenantStatus.READY);
    expect((await events()).map((event) => event.action)).toEqual([
      'tenant.provisioning.attempted',
      'tenant.provisioning.failed',
      'tenant.provisioning.attempted',
      'tenant.provisioning.succeeded',
    ]);
  });
  it('recovers after several consecutive sequential failures at the same step before eventually succeeding', async () => {
    const attempts = 4;
    for (let i = 0; i < attempts - 1; i += 1) {
      failAt = 'bucket';
      await expect(run()).rejects.toThrow('Tenant provisioning failed');
      expect((await tenant()).status).toBe(TenantStatus.FAILED);
    }
    await run();
    const current = await tenant();
    expect(current.status).toBe(TenantStatus.READY);
    expect(current.provisioningAttempts).toBe(attempts);
    expect(await controlDataSource.getRepository(Tenant).countBy({ accountId: account.id })).toBe(
      1,
    );
    expect(
      await controlDataSource.getRepository(Subscription).countBy({ tenantId: current.id }),
    ).toBe(1);
    expect(buckets.size).toBe(1);
    expect(databases.size).toBe(1);
    const expectedEvents: string[] = [];
    for (let i = 0; i < attempts - 1; i += 1) {
      expectedEvents.push('tenant.provisioning.attempted', 'tenant.provisioning.failed');
    }
    expectedEvents.push('tenant.provisioning.attempted', 'tenant.provisioning.succeeded');
    expect((await events()).map((event) => event.action)).toEqual(expectedEvents);
  });
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
    expect(bindings.has(account.keycloakUserId)).toBe(false);
    expect(keycloak.revokeWorkspaceOwner).toHaveBeenCalledWith(account.keycloakUserId, current.id);
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
  it('compensates when the final Ready transaction commit fails', async () => {
    const original = controlDataSource.createQueryRunner.bind(controlDataSource);
    let first = true;
    let commits = 0;
    const spy = jest.spyOn(controlDataSource, 'createQueryRunner').mockImplementation((mode) => {
      const runner = original(mode);
      if (first) {
        first = false;
        const commit = runner.commitTransaction.bind(runner);
        jest.spyOn(runner, 'commitTransaction').mockImplementation(async () => {
          commits += 1;
          if (commits === 4) throw new Error('private-commit-secret');
          await commit();
        });
      }
      return runner;
    });
    try {
      await expect(run()).rejects.toThrow('Tenant provisioning failed');
    } finally {
      spy.mockRestore();
    }
    expect(commits).toBe(5); // the Failed/audit transaction commits after final rollback
    expect((await tenant()).status).toBe(TenantStatus.FAILED);
    expect(bindings.has(account.keycloakUserId)).toBe(false);
    expect(keycloak.revokeWorkspaceOwner).toHaveBeenCalledWith(
      account.keycloakUserId,
      (await tenant()).id,
    );
    expect((await events()).map((event) => event.action)).toEqual([
      'tenant.provisioning.attempted',
      'tenant.provisioning.failed',
    ]);
    await run();
    expect((await tenant()).status).toBe(TenantStatus.READY);
  });

  it('persists Failed/audit despite revoke failure, then recovers on retry', async () => {
    failSuccessAudit = true;
    failRevoke = true;
    await expect(run()).rejects.toThrow('Tenant provisioning failed');
    expect((await tenant()).status).toBe(TenantStatus.FAILED);
    expect((await events()).map((event) => event.action)).toEqual([
      'tenant.provisioning.attempted',
      'tenant.provisioning.failed',
    ]);
    expect(bindings.get(account.keycloakUserId)).toBe((await tenant()).id);
    const issuer = 'http://127.0.0.1/realms/t046-revoke-failure';
    const audience = 'kemfai-api-t046-revoke-failure';
    const kc = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = kc.jwksUri;
    let app: INestApplication | undefined;
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule, OwnerProbeModule],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      const id = (await tenant()).id;
      const stale = await kc.signAccessToken({
        sub: account.keycloakUserId,
        roles: ['WorkspaceOwner'],
        tenantId: id,
      });
      for (const path of [`/t046-probe/tenants/${id}`, `/t046-probe/scope-only/tenants/${id}`]) {
        await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${stale}`)
          .expect(403);
      }
      await request(app.getHttpServer())
        .get('/tenants/me')
        .set('Authorization', `Bearer ${stale}`)
        .expect(200);
    } finally {
      if (app) await app.close();
      await kc.close();
      delete process.env.KEYCLOAK_ISSUER;
      delete process.env.KEYCLOAK_API_AUDIENCE;
      delete process.env.KEYCLOAK_JWKS_URI;
    }
    await run();
    expect((await tenant()).status).toBe(TenantStatus.READY);
    expect(keycloak.assignWorkspaceOwner).toHaveBeenCalledTimes(2);
  });

  it('binds the persisted owner identity to guards after success and denies another tenant', async () => {
    await run();
    const ownTenant = await tenant();
    const otherAccount = await controlDataSource.getRepository(Account).save({
      keycloakUserId: randomUUID(),
      email: `t046-other-${randomUUID()}@example.com`,
      emailVerified: true,
    });
    const otherTenant = await controlDataSource
      .getRepository(Tenant)
      .save({ accountId: otherAccount.id });
    const issuer = 'http://127.0.0.1/realms/kemfai-customers-t046';
    const audience = 'kemfai-api-t046';
    const kc = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = kc.jwksUri;
    let app: INestApplication | undefined;
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule, OwnerProbeModule],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      const roles = bindings.has(account.keycloakUserId) ? ['WorkspaceOwner'] : [];
      const token = await kc.signAccessToken({
        sub: account.keycloakUserId,
        roles,
        tenantId: ownTenant.id,
      });
      const missingClaim = await kc.signAccessToken({ sub: account.keycloakUserId, roles });
      const mismatchedClaim = await kc.signAccessToken({
        sub: account.keycloakUserId,
        roles,
        tenantId: otherTenant.id,
      });
      for (const denied of [missingClaim, mismatchedClaim]) {
        await request(app.getHttpServer())
          .get(`/t046-probe/tenants/${ownTenant.id}`)
          .set('Authorization', `Bearer ${denied}`)
          .expect(403);
      }
      expect(bindings.get(account.keycloakUserId)).toBe(ownTenant.id);
      await request(app.getHttpServer())
        .get(`/t046-probe/tenants/${ownTenant.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/t046-probe/scope-only/tenants/${ownTenant.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const noRole = await kc.signAccessToken({
        sub: account.keycloakUserId,
        tenantId: ownTenant.id,
      });
      await request(app.getHttpServer())
        .get(`/t046-probe/scope-only/tenants/${ownTenant.id}`)
        .set('Authorization', `Bearer ${noRole}`)
        .expect(403);
      for (const denied of [missingClaim, mismatchedClaim]) {
        await request(app.getHttpServer())
          .get(`/t046-probe/scope-only/tenants/${ownTenant.id}`)
          .set('Authorization', `Bearer ${denied}`)
          .expect(403);
      }
      await request(app.getHttpServer())
        .get(`/t046-probe/tenants/${otherTenant.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      // A stale signed role claim cannot authorize a workspace after a failed transition,
      // even if remote compensation is temporarily unavailable.
      await controlDataSource
        .getRepository(Tenant)
        .update(ownTenant.id, { status: TenantStatus.FAILED });
      await request(app.getHttpServer())
        .get(`/t046-probe/tenants/${ownTenant.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/t046-probe/scope-only/tenants/${ownTenant.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      // Onboarding status is intentionally reachable even with a stale signed owner token.
      await request(app.getHttpServer())
        .get('/tenants/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await controlDataSource
        .getRepository(Tenant)
        .update(ownTenant.id, { status: TenantStatus.READY });
      const withoutRole = await kc.signAccessToken({ sub: account.keycloakUserId });
      await request(app.getHttpServer())
        .get(`/t046-probe/tenants/${ownTenant.id}`)
        .set('Authorization', `Bearer ${withoutRole}`)
        .expect(403);
    } finally {
      if (app) await app.close();
      await kc.close();
      delete process.env.KEYCLOAK_ISSUER;
      delete process.env.KEYCLOAK_API_AUDIENCE;
      delete process.env.KEYCLOAK_JWKS_URI;
      await controlDataSource.query('DELETE FROM audit_event WHERE tenant_id = $1', [ownTenant.id]);
      await controlDataSource.getRepository(Tenant).delete(otherTenant.id);
      await controlDataSource.getRepository(Account).delete(otherAccount.id);
    }
  });

  it('carries the signup-generated Keycloak ID through provisioning to both guards', async () => {
    const users = new FakeKeycloakUsers();
    const issuer = 'http://127.0.0.1/realms/t046-signup';
    const audience = 'kemfai-api-t046-signup';
    const kc = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = kc.jwksUri;
    let app: INestApplication | undefined;
    let generated: Account | undefined;
    const originalFlag = (await controlDataSource.query(
      "SELECT enabled FROM feature_flag WHERE feature_key = 'module.accounts'",
    )) as Array<{ enabled: boolean }>;
    try {
      await controlDataSource.query(
        "UPDATE feature_flag SET enabled = true WHERE feature_key = 'module.accounts'",
      );
      await controlDataSource
        .getRepository(Plan)
        .update(plan.id, { published: true, nameEn: 'Test plan', nameAr: 'Test plan' });
      const moduleRef = await Test.createTestingModule({ imports: [AppModule, OwnerProbeModule] })
        .overrideProvider(KEYCLOAK_USER_PROVISIONER)
        .useValue(users)
        .compile();
      app = moduleRef.createNestApplication();
      await app.init();
      const email = `t046-generated-${randomUUID()}@example.com`;
      const signup = await request(app.getHttpServer())
        .post('/accounts/signup')
        .send({
          email,
          password: 'test-strong-password',
          planId: plan.id,
          billingCycle: 'monthly',
          acceptedTerms: true,
        })
        .expect(201);
      generated = await controlDataSource
        .getRepository(Account)
        .findOneByOrFail({ id: signup.body.accountId as string });
      const user = users.userByEmail(email);
      expect(user?.id).toBe(generated.keycloakUserId);
      expect(generated.keycloakUserId).not.toBe(generated.id);
      // Verification's resulting persisted state is the worker's precondition.
      await controlDataSource.getRepository(Account).update(generated.id, { emailVerified: true });
      await users.markEmailVerified(generated.keycloakUserId);
      const worker = new TenantProvisionProcessor(
        audit,
        storage as unknown as MinioStorageService,
        odoo as unknown as OdooRpcService,
        users,
      );
      await worker.process({ data: { accountId: generated.id } } as Job<{ accountId: string }>);
      const ready = await controlDataSource
        .getRepository(Tenant)
        .findOneByOrFail({ accountId: generated.id });
      expect(ready.status).toBe(TenantStatus.READY);
      expect(user?.roles).toEqual(['WorkspaceOwner']);
      expect(user?.attributes?.tenant_id).toEqual([ready.id]);
      const token = await kc.signAccessToken({
        sub: user!.id,
        roles: user!.roles,
        tenantId: ready.id,
      });
      await request(app.getHttpServer())
        .get(`/t046-probe/tenants/${ready.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await controlDataSource
        .getRepository(Tenant)
        .update(ready.id, { status: TenantStatus.FAILED });
      await request(app.getHttpServer())
        .get(`/t046-probe/tenants/${ready.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    } finally {
      if (app) {
        const queue = app.get<Queue>(getQueueToken(QUEUE_EMAIL_SEND_VERIFICATION));
        const jobs = await queue.getJobs(
          ['wait', 'waiting', 'delayed', 'active', 'completed', 'failed'],
          0,
          1000,
        );
        for (const job of jobs)
          if (job.data?.accountId === generated?.id) await queue.remove(job.id as string);
        await app.close();
      }
      await kc.close();
      delete process.env.KEYCLOAK_ISSUER;
      delete process.env.KEYCLOAK_API_AUDIENCE;
      delete process.env.KEYCLOAK_JWKS_URI;
      if (generated) {
        const t = await controlDataSource
          .getRepository(Tenant)
          .findOneBy({ accountId: generated.id });
        if (t) {
          await controlDataSource.query('DELETE FROM audit_event WHERE tenant_id = $1', [t.id]);
          await controlDataSource.getRepository(Subscription).delete({ tenantId: t.id });
          await controlDataSource.getRepository(Tenant).delete(t.id);
        }
        await controlDataSource.query('DELETE FROM audit_event WHERE actor_id = $1', [
          generated.id,
        ]);
        await controlDataSource.query(
          'DELETE FROM email_verification_token WHERE account_id = $1',
          [generated.id],
        );
        await controlDataSource.getRepository(Account).delete(generated.id);
      }
      if (originalFlag.length) {
        await controlDataSource.query(
          "UPDATE feature_flag SET enabled = $1 WHERE feature_key = 'module.accounts'",
          [originalFlag[0].enabled],
        );
      }
    }
  });

  it('rolls back failed attempted audit and commits Failed with a failed event', async () => {
    failAudit = true;
    await expect(run()).rejects.toThrow('Tenant provisioning failed');
    expect((await tenant()).status).toBe(TenantStatus.FAILED);
    expect((await tenant()).provisioningAttempts).toBe(0);
    expect((await events()).map((event) => event.action)).toEqual(['tenant.provisioning.failed']);
  });
});
