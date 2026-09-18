import { Controller, Get, Module, NotFoundException, Param } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Public } from '../../src/common/decorators/public.decorator';
import { TenantOwnedResource } from '../../src/common/tenant-context/tenant-owned-resource.decorator';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

/**
 * T017 acceptance test, end to end against the real guard chain (globally applied
 * BearerAuthGuard + TenantScopeGuard), real Postgres audit_event writes, and real JWKS
 * fetches. Covers the two behaviors the previous rejected attempt missed:
 *  1. resources addressed by an ORDINARY resource ID are ownership-checked (not just
 *     explicit tenantId values), and
 *  2. the tenant_access.denied_cross_tenant row is written before the guard exits.
 */
@Controller('test-scope')
class ProbeController {
  @Get('tenants/:tenantId')
  explicitTenantParam(): { ok: true } {
    return { ok: true };
  }

  @Get('subscriptions/:id')
  @TenantOwnedResource({ resource: 'subscription', idParam: 'id' })
  async subscriptionById(@Param('id') id: string): Promise<{ id: string }> {
    const rows = await controlDataSource.query('SELECT id FROM subscription WHERE id = $1', [id]);
    if (!rows.length) {
      throw new NotFoundException();
    }
    return { id: rows[0].id };
  }

  @Get('public')
  @Public()
  publicProbe(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const KC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KC_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

describe('TenantScopeGuard (T017, integration)', () => {
  const issuer = 'http://127.0.0.1/realms/kemfai-customers-scope-test';
  const audience = 'kemfai-api-scope-test';
  let keycloak: FakeKeycloak;
  let app: INestApplication;
  let tenantA: string;
  let tenantB: string;
  let subscriptionB: string;
  let accountA: string;
  let planId: string;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    keycloak = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;

    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, ProbeModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  async function seedAccountWithTenant(keycloakUserId: string, email: string) {
    const accountRepo = controlDataSource.getRepository(Account);
    const account = await accountRepo.save(
      accountRepo.create({
        keycloakUserId,
        email,
        emailVerified: true,
        selectedPlanId: planId,
      }),
    );
    const result = await controlDataSource.query(
      "INSERT INTO tenant (account_id, status) VALUES ($1, 'Ready'::tenant_status_enum) RETURNING id",
      [account.id],
    );
    return { accountId: account.id as string, tenantId: result[0].id as string };
  }

  beforeEach(async () => {
    const planRepo = controlDataSource.getRepository(Plan);
    const plan = await planRepo.save(
      planRepo.create({
        name: `plan-scope-${Date.now()}`,
        published: true,
        monthlyPrice: '10.00',
        annualPrice: '100.00',
        currency: 'USD',
      }),
    );
    planId = plan.id;

    const seededA = await seedAccountWithTenant(KC_A, 'scope-a@example.com');
    const seededB = await seedAccountWithTenant(KC_B, 'scope-b@example.com');
    accountA = seededA.accountId;
    tenantA = seededA.tenantId;
    tenantB = seededB.tenantId;

    const sub = await controlDataSource.query(
      `INSERT INTO subscription (tenant_id, plan_id, billing_cycle, status, current_period_start, current_period_end)
       VALUES ($1, $2, 'monthly'::subscription_billing_cycle_enum, 'PendingActivation'::subscription_status_enum, '2026-01-01', '2026-02-01')
       RETURNING id`,
      [tenantB, planId],
    );
    subscriptionB = sub[0].id;

    tokenA = await keycloak.signAccessToken({ sub: KC_A });
    tokenB = await keycloak.signAccessToken({ sub: KC_B });
  });

  afterEach(async () => {
    await controlDataSource.query('DELETE FROM audit_event');
    await controlDataSource.query('DELETE FROM subscription');
    await controlDataSource.query('DELETE FROM tenant');
    await controlDataSource.query('DELETE FROM account');
    await controlDataSource.query('DELETE FROM plan');
  });

  afterAll(async () => {
    await app.close();
    await keycloak.close();
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
    delete process.env.KEYCLOAK_ISSUER;
    delete process.env.KEYCLOAK_API_AUDIENCE;
    delete process.env.KEYCLOAK_JWKS_URI;
  });

  async function denialEvents(): Promise<Record<string, unknown>[]> {
    return controlDataSource.query(
      "SELECT * FROM audit_event WHERE action = 'tenant_access.denied_cross_tenant'",
    );
  }

  it('leaves @Public() routes reachable without a token', async () => {
    await request(app.getHttpServer()).get('/test-scope/public').expect(200);
    await request(app.getHttpServer()).get('/').expect(200);
  });

  it('still rejects unauthenticated calls to protected routes with 401 (no tenant denial audited)', async () => {
    await request(app.getHttpServer()).get(`/test-scope/tenants/${tenantB}`).expect(401);
    expect(await denialEvents()).toHaveLength(0);
  });

  it('allows a caller referencing its own tenant explicitly', async () => {
    await request(app.getHttpServer())
      .get(`/test-scope/tenants/${tenantA}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(await denialEvents()).toHaveLength(0);
  });

  it('denies an explicit Tenant B tenantId in the path (403) and writes the audit event with the CALLER tenant', async () => {
    const response = await request(app.getHttpServer())
      .get(`/test-scope/tenants/${tenantB}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(403);

    expect(response.body.message).toContain('tenant scope');
    const events = await denialEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_type: 'account',
      actor_id: accountA,
      tenant_id: tenantA,
      subject_type: 'tenant',
      subject_id: tenantB,
      action: 'tenant_access.denied_cross_tenant',
    });
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.target_tenant_id).toBe(tenantB);
    expect(String(payload.resource_path)).toContain(`/test-scope/tenants/${tenantB}`);
  });

  it('denies a spoofed x-tenant-id header and audits it', async () => {
    await request(app.getHttpServer())
      .get(`/test-scope/tenants/${tenantA}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('x-tenant-id', tenantB)
      .expect(403);

    const events = await denialEvents();
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).target_tenant_id).toBe(tenantB);
    expect((events[0].payload as Record<string, unknown>).reference_source).toBe('header');
  });

  it('denies Tenant A reading Tenant B’s subscription addressed by ORDINARY resource ID (403) and audits it', async () => {
    await request(app.getHttpServer())
      .get(`/test-scope/subscriptions/${subscriptionB}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(403);

    const events = await denialEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_type: 'account',
      actor_id: accountA,
      tenant_id: tenantA,
      subject_type: 'subscription',
      subject_id: subscriptionB,
    });
    expect((events[0].payload as Record<string, unknown>).target_tenant_id).toBe(tenantB);
  });

  it('allows Tenant B reading its own subscription by ordinary resource ID', async () => {
    await request(app.getHttpServer())
      .get(`/test-scope/subscriptions/${subscriptionB}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(await denialEvents()).toHaveLength(0);
  });

  it('passes an unknown subscription ID through to a 404 without auditing a denial', async () => {
    await request(app.getHttpServer())
      .get('/test-scope/subscriptions/99999999-9999-4999-8999-999999999999')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
    expect(await denialEvents()).toHaveLength(0);
  });

  it('keeps the existing protected surface (GET /entitlements/me) rejecting anonymous calls with 401', async () => {
    await request(app.getHttpServer()).get('/entitlements/me').expect(401);
  });
});
