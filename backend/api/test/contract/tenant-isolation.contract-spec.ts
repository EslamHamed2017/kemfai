import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';
import { OdooRpcService } from '../../src/integrations/odoo-rpc/odoo-rpc.service';
import { computeCompanySetupScope } from '../../src/modules/company-setup/company-setup-scope.util';

/**
 * T054 added a real `kemfai_setup_get_state`/`kemfai_setup_save_step` Odoo RPC call to the
 * `GET /companies/current/setup` handler this suite's guard-wiring assertions exercise.
 * This suite's job is the guard chain (TenantScopeGuard/RoleGuard/FeatureFlagGuard/
 * TrialWindowGuard), not a live Odoo transport — matching every other module's test
 * strategy in this repo (`odoo-rpc.service.spec.ts`, `tenant-provision.startup.spec.ts`),
 * a deterministic fake is substituted for `OdooRpcService` so "reaches the handler" can be
 * asserted without requiring a live Odoo instance in the contract-test tier. The live,
 * real-Odoo proof of the handler's own behavior is
 * `backend/addons/kemfai_company_setup/tests/test_company_setup.py` (scripts/test_t054_live.sh)
 * plus `test/integration/company-setup-live.integration-spec.ts`.
 */
class FakeOdooRpcService {
  async authenticate(): Promise<number> {
    return 1;
  }

  async executeKw(
    _database: string,
    _uid: number,
    _password: string,
    model: string,
    method: string,
  ): Promise<unknown> {
    if (model === 'res.company' && method === 'search') return [42];
    if (model === 'res.company' && method === 'kemfai_setup_get_state') {
      return { currentStep: 'country', setupComplete: false, values: {}, version: 0, stale: false };
    }
    if (model === 'res.company' && method === 'kemfai_setup_save_step') {
      return {
        currentStep: 'identity',
        setupComplete: false,
        values: {},
        version: 1,
        stale: false,
      };
    }
    throw new Error(`FakeOdooRpcService: unexpected call ${model}.${method}`);
  }
}

/**
 * T042 (arbiter resolution, 2026-10-04). Exercises the real guard chain end to end against the
 * two documented customer-facing surfaces named in tasks.md: `GET /tenants/me` (already
 * implemented) and `GET /companies/current/setup` (the real route this task registers,
 * gated behind `module.company_setup`/`TrialWindowGuard` per T054's own requirement). Both
 * sections hit a genuinely booted AppModule + Postgres, never a schema-only ContractCoverage
 * recording — a prior attempt was rejected for exactly that shortcut (docs/PROGRESS.md,
 * 2026-10-04 12:05).
 *
 * Because `TenantScopeGuard` runs before `FeatureFlagGuard`/`TrialWindowGuard` in
 * app.module.ts's APP_GUARD chain, a cross-tenant request is denied and audited before the
 * company-setup flag/trial state is ever consulted — so the cross-tenant assertions below are
 * valid regardless of `module.company_setup`'s enabled state.
 */
describe('Cross-tenant denial + company-setup guard wiring (T042)', () => {
  const COMPANY_SETUP_FLAG = 'module.company_setup';
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const issuer = 'http://127.0.0.1/realms/kemfai-customers-t042';
  const audience = 'kemfai-api-t042';
  const KC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const KC_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';

  let keycloak: FakeKeycloak;
  let app: INestApplication;
  let planId: string;
  let accountA: string;
  let tenantA: string;
  let tenantB: string;
  let tokenA: string;

  beforeAll(async () => {
    keycloak = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;

    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OdooRpcService)
      .useValue(new FakeOdooRpcService())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  async function seedAccountWithTenant(keycloakUserId: string, email: string, readyAt?: Date) {
    const accountRepo = controlDataSource.getRepository(Account);
    const account = await accountRepo.save(
      accountRepo.create({ keycloakUserId, email, emailVerified: true, selectedPlanId: planId }),
    );
    // T056 round-6: a real Ready tenant always carries BOTH its Odoo database name and
    // the company id TenantProvisionProcessor.verifyCompany captured for it — the fixture
    // mirrors that invariant with the same id FakeOdooRpcService's `res.company` search
    // resolves to (42), never a guessed/unrelated value.
    const result = await controlDataSource.query(
      "INSERT INTO tenant (account_id, status, odoo_db_name, odoo_company_id) VALUES ($1, 'Ready'::tenant_status_enum, $2, 42) RETURNING id",
      [account.id, `t042_fake_${keycloakUserId}`],
    );
    const tenantId = result[0].id as string;
    if (readyAt) {
      await controlDataSource.query('UPDATE tenant SET ready_at = $1 WHERE id = $2', [
        readyAt,
        tenantId,
      ]);
    }
    return { accountId: account.id as string, tenantId };
  }

  async function createSubscription(
    tenantId: string,
    status: 'PendingActivation' | 'Active',
  ): Promise<void> {
    await controlDataSource.query(
      `INSERT INTO subscription (tenant_id, plan_id, billing_cycle, status, current_period_start, current_period_end)
       VALUES ($1, $2, 'monthly'::subscription_billing_cycle_enum, $3::subscription_status_enum, '2026-01-01', '2026-02-01')`,
      [tenantId, planId, status],
    );
  }

  beforeEach(async () => {
    const planRepo = controlDataSource.getRepository(Plan);
    const plan = await planRepo.save(
      planRepo.create({
        name: `plan-t042-${Date.now()}`,
        published: true,
        monthlyPrice: '10.00',
        annualPrice: '100.00',
        currency: 'USD',
      }),
    );
    planId = plan.id;

    const seededA = await seedAccountWithTenant(KC_A, `t042-a-${Date.now()}@example.com`);
    const seededB = await seedAccountWithTenant(KC_B, `t042-b-${Date.now()}@example.com`);
    accountA = seededA.accountId;
    tenantA = seededA.tenantId;
    tenantB = seededB.tenantId;

    tokenA = await keycloak.signAccessToken({
      sub: KC_A,
      roles: ['WorkspaceOwner'],
      tenantId: tenantA,
    });
  });

  afterEach(async () => {
    await controlDataSource.query('DELETE FROM audit_event');
    await controlDataSource.query('DELETE FROM subscription');
    await controlDataSource.query('DELETE FROM tenant');
    await controlDataSource.query('DELETE FROM account');
    await controlDataSource.query('DELETE FROM plan');
    await controlDataSource.query(
      'UPDATE feature_flag SET enabled = false WHERE feature_key = $1',
      [COMPANY_SETUP_FLAG],
    );
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

  async function setCompanySetupFlagEnabled(enabled: boolean): Promise<void> {
    await controlDataSource.query('UPDATE feature_flag SET enabled = $1 WHERE feature_key = $2', [
      enabled,
      COMPANY_SETUP_FLAG,
    ]);
  }

  describe('cross-tenant denial', () => {
    it('denies GET /tenants/me with a spoofed x-tenant-id header (403) and audits tenant_access.denied_cross_tenant', async () => {
      await request(app.getHttpServer())
        .get('/tenants/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('x-tenant-id', tenantB)
        .expect(403);

      const events = await denialEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor_type: 'account',
        actor_id: accountA,
        tenant_id: tenantA,
        action: 'tenant_access.denied_cross_tenant',
      });
      const payload = events[0].payload as Record<string, unknown>;
      expect(payload.target_tenant_id).toBe(tenantB);
      expect(String(payload.resource_path)).toContain('/tenants/me');
    });

    it('denies GET /companies/current/setup with a spoofed x-tenant-id header (403) and audits tenant_access.denied_cross_tenant', async () => {
      await request(app.getHttpServer())
        .get('/companies/current/setup')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('x-tenant-id', tenantB)
        .expect(403);

      const events = await denialEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor_type: 'account',
        actor_id: accountA,
        tenant_id: tenantA,
        action: 'tenant_access.denied_cross_tenant',
      });
      const payload = events[0].payload as Record<string, unknown>;
      expect(payload.target_tenant_id).toBe(tenantB);
      expect(String(payload.resource_path)).toContain('/companies/current/setup');
    });
  });

  describe('company-setup guard wiring', () => {
    it('same-tenant access gets 404 while module.company_setup is disabled', async () => {
      await request(app.getHttpServer())
        .get('/companies/current/setup')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
      expect(await denialEvents()).toHaveLength(0);
    });

    it('once enabled, an elapsed unpaid trial (no Active subscription) gets 403', async () => {
      await setCompanySetupFlagEnabled(true);
      await controlDataSource.query('UPDATE tenant SET ready_at = $1 WHERE id = $2', [
        new Date(Date.now() - 20 * MS_PER_DAY),
        tenantA,
      ]);
      await createSubscription(tenantA, 'PendingActivation');

      await request(app.getHttpServer())
        .get('/companies/current/setup')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(403);
    });

    it('once enabled, an Active subscription reaches the handler regardless of elapsed time', async () => {
      await setCompanySetupFlagEnabled(true);
      await controlDataSource.query('UPDATE tenant SET ready_at = $1 WHERE id = $2', [
        new Date(Date.now() - 999 * MS_PER_DAY),
        tenantA,
      ]);
      await createSubscription(tenantA, 'Active');

      const response = await request(app.getHttpServer())
        .get('/companies/current/setup')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(response.body).toMatchObject({ currentStep: 'country', setupComplete: false });
    });

    it('once enabled, a non-expired trial reaches the handler', async () => {
      await setCompanySetupFlagEnabled(true);
      await controlDataSource.query('UPDATE tenant SET ready_at = $1 WHERE id = $2', [
        new Date(Date.now() - 2 * MS_PER_DAY),
        tenantA,
      ]);
      await createSubscription(tenantA, 'PendingActivation');

      const response = await request(app.getHttpServer())
        .get('/companies/current/setup')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(response.body).toMatchObject({ currentStep: 'country', setupComplete: false });
    });
  });

  // T056 round-6 (required work item 3) — proves the exact "zero Odoo RPC" condition the
  // round-5 review found only indirectly demonstrated: `company-setup-live.integration-spec.ts`'s
  // "never reaches Odoo" cases only assert unchanged `res.company` state via a direct
  // Odoo read performed AFTER the 422 — that read is itself an Odoo call, so it cannot
  // prove the REJECTED request made zero RPCs. Here `FakeOdooRpcService.authenticate`/
  // `executeKw` are wrapped with jest spies so the count attributable to the rejected HTTP
  // request itself can be asserted directly, against the real app/real global
  // ValidationPipe/real guard chain (never a mocked controller/service).
  describe('PUT /companies/current/setup invalid envelopes never reach Odoo (T056 item 3)', () => {
    let authenticateSpy: jest.SpyInstance;
    let executeKwSpy: jest.SpyInstance;
    let fakeOdoo: OdooRpcService;

    beforeAll(() => {
      fakeOdoo = app.get(OdooRpcService);
    });

    beforeEach(async () => {
      authenticateSpy = jest.spyOn(fakeOdoo, 'authenticate');
      executeKwSpy = jest.spyOn(fakeOdoo, 'executeKw');
      await setCompanySetupFlagEnabled(true);
      await createSubscription(tenantA, 'Active');
    });

    afterEach(() => {
      authenticateSpy.mockRestore();
      executeKwSpy.mockRestore();
    });

    it('rejects an unknown "step" value (422) with zero authenticate/executeKw calls', async () => {
      await request(app.getHttpServer())
        .put('/companies/current/setup')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('X-KEMFAI-Setup-Scope', 'irrelevant-before-validation')
        .send({ step: 'not_a_real_step', values: {} })
        .expect(422);

      expect(authenticateSpy).toHaveBeenCalledTimes(0);
      expect(executeKwSpy).toHaveBeenCalledTimes(0);
    });

    it('rejects a negative "baseVersion" (422) with zero authenticate/executeKw calls', async () => {
      await request(app.getHttpServer())
        .put('/companies/current/setup')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('X-KEMFAI-Setup-Scope', 'irrelevant-before-validation')
        .send({ step: 'country', values: { country: 'AE' }, baseVersion: -1 })
        .expect(422);

      expect(authenticateSpy).toHaveBeenCalledTimes(0);
      expect(executeKwSpy).toHaveBeenCalledTimes(0);
    });

    it('rejects a non-integer (fractional) "baseVersion" (422) with zero authenticate/executeKw calls', async () => {
      await request(app.getHttpServer())
        .put('/companies/current/setup')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('X-KEMFAI-Setup-Scope', 'irrelevant-before-validation')
        .send({ step: 'country', values: { country: 'AE' }, baseVersion: 1.5 })
        .expect(422);

      expect(authenticateSpy).toHaveBeenCalledTimes(0);
      expect(executeKwSpy).toHaveBeenCalledTimes(0);
    });

    it('control: a VALID save with the correct scope on the same tenant/flag/subscription state DOES reach authenticate/executeKw', async () => {
      const validScope = computeCompanySetupScope(tenantA, accountA, 42);
      await request(app.getHttpServer())
        .put('/companies/current/setup')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('X-KEMFAI-Setup-Scope', validScope)
        .send({ step: 'country', values: { country: 'AE' } });

      expect(authenticateSpy.mock.calls.length + executeKwSpy.mock.calls.length).toBeGreaterThan(0);
    });
  });
});
