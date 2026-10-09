import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import controlDataSource from '../../src/database/data-source';
import { AppModule } from '../../src/app.module';
import { Account, BillingCycle } from '../../src/modules/accounts/entities/account.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import { OdooRpcService } from '../../src/integrations/odoo-rpc/odoo-rpc.service';
import { createOdooRpcClient } from '../../src/integrations/odoo-rpc/odoo-rpc-client';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

/**
 * T054 live HTTP harness. Gated by `KEMFAI_LIVE_T054=1` (same `describe`/`describe.skip`
 * gating convention as T044's `tenant-provisioning-live.integration-spec.ts`) so a normal
 * `npm run test:integration` run never requires Docker/Odoo. `scripts/test_t054_live.sh` is
 * the only caller that sets this flag, and only after it has itself verified Docker/Odoo/
 * Postgres are actually reachable — the script fails hard (not skip) when they are not; this
 * spec file simply trusts that contract once the flag is set.
 *
 * Every Odoo call here goes against the `KEMFAI_T054_TENANT_DB` scratch database the script
 * creates on an ISOLATED Odoo container it starts for this run (never the shared
 * `kemfai-odoo` dev container) — real `res.company` persistence, real `kemfai_setup_*` RPC
 * methods, no `OdooRpcService` mock. `CONTROL_DB_NAME` is likewise the scratch control
 * database the script creates and migrates before invoking Jest; this spec never touches
 * `kemfai_control`.
 *
 * The isolated Odoo container runs with `list_db = False`, so `exp_create_database`
 * (`ir.http`'s `check_db_management_enabled`) would raise `AccessDenied` on any RPC
 * `db.create_database` call against it — this is the correct, intended behaviour of a
 * locked-down container and must not be worked around by enabling listing/management.
 * `KEMFAI_T054_TENANT_DB` is therefore expected to already exist, with
 * `kemfai_tenant_core`/`kemfai_company_setup` installed and the admin login/password below
 * already configured, via the offline bootstrap CLI container that
 * `scripts/test_t054_live.sh` runs (odoo -i / odoo shell, `--stop-after-init`) before it
 * starts the list_db=False HTTP server. This fixture only authenticates against that
 * preinitialized database; it never calls `createDatabase`/`exp_create_database`. The
 * script sets `KEMFAI_T054_DB_PREINITIALIZED=1` to attest that bootstrap happened; this
 * spec refuses to run without it rather than silently falling back to the forbidden RPC.
 *
 * T055 (2026-10-05) extends this SAME fixture/scratch-DB set — rather than owning a
 * second one — with `POST /companies/current/setup/complete` and
 * `GET`/`PUT /companies/current/settings` cases, reusing `resetCompanyToPristine`/
 * `seedCountryAndVat`/the owner/non-owner tokens exactly as the T054 cases above do.
 */
const live = process.env.KEMFAI_LIVE_T054 === '1' ? describe : describe.skip;

live('T054 live HTTP harness: GET/PUT /companies/current/setup (real Odoo + scratch DBs)', () => {
  const issuer = 'http://127.0.0.1/realms/kemfai-customers-t054';
  const audience = 'kemfai-api-t054';
  const KC_OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaa1';
  const KC_NON_OWNER = 'eeeeeeee-ffff-4aaa-8bbb-eeeeeeeeeee1';
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  let keycloak: FakeKeycloak;
  let app: INestApplication;
  let odoo: OdooRpcService;
  let tenantDb: string;
  let odooLogin: string;
  let odooPassword: string;
  let odooUid: number;
  let planId: string;
  let tenantId: string;
  let ownerToken: string;
  let nonOwnerToken: string;

  let originalFlagEnabled: boolean | null = null;
  let companyId: number;
  let pristineCompanyFields: Record<string, unknown>;
  // T056 round 3 — the opaque scope is stable for the lifetime of this fixture's single
  // owned tenant/account/company (scope is a function of exactly those three, none of
  // which this file's cases ever change), so it is fetched once via a real GET and
  // echoed on every PUT/POST below — exactly what a real browser session would do,
  // never a client-fabricated value.
  let scope: string;

  // Every field T054's wizard reads/writes, plus the step/version/completion bookkeeping
  // fields that ride alongside them — the exact set needed to restore this run's owned
  // scratch company back to the state it was in when this fixture first read it, so each
  // HTTP case below can start from pristine wizard data instead of depending on whatever
  // an earlier case happened to leave behind.
  const WIZARD_FIELDS = [
    'country',
    'legal_name',
    'trade_name',
    'base_currency',
    'fiscal_year_start_month',
    'fiscal_year_start_day',
    'vat_tax_registration',
    'industry',
    'accounting_setup_template',
    'setup_wizard_step',
    'setup_complete',
    'setup_completed_at',
    'setup_wizard_version',
  ];

  // Odoo's read() returns Many2one fields as [id, display_name] (or false); write() wants
  // just the id (or false) — this normalizes a captured snapshot value back into a
  // write()-ready one.
  function normalizeMany2one(raw: unknown): unknown {
    return Array.isArray(raw) ? raw[0] : raw;
  }

  // Resets this run's own scratch company (never any other record) directly via real Odoo
  // RPC back to the exact raw field values captured in beforeAll before any HTTP case ran —
  // a genuine write() against the owned tenant DB, not a fake/mocked RPC — so each case
  // below can declare "pristine wizard data" as its starting precondition regardless of
  // what any earlier case did.
  async function resetCompanyToPristine(): Promise<void> {
    const writeVals: Record<string, unknown> = {};
    for (const field of WIZARD_FIELDS) {
      writeVals[field] = normalizeMany2one(pristineCompanyFields[field]);
    }
    await odoo.executeKw(tenantDb, odooUid, odooPassword, 'res.company', 'write', [
      [companyId],
      writeVals,
    ]);
    // T055 durable-handoff remediation: the completion `company_mutation_handoff` is
    // capped at one row per tenant FOREVER (AC3.7 — see
    // CompanyMutationHandoffService.findOrCreateCompletionHandoff), so once any case in
    // this file completes setup, a later case that resets Odoo back to incomplete and
    // expects a genuinely fresh completion (fresh version/values in the response, or a
    // fresh audit row after `clearAuditEvents`) would otherwise get the FIRST
    // completion's cached response replayed instead of a real one. "Pristine" must
    // include this control-plane state, not only the Odoo-side fields, for every case
    // below to remain order-independent.
    await controlDataSource.query('DELETE FROM company_mutation_handoff WHERE tenant_id = $1', [
      tenantId,
    ]);
  }

  // Seeds a country + a VAT value that is valid for that country's configured rule,
  // through the real HTTP PUT surface under test (never a direct RPC write) — used by
  // cases that need an already-persisted, independently-established country/VAT
  // precondition rather than relying on a previous case's success.
  async function seedCountryAndVat(countryCode: string, vat: string): Promise<{ version: number }> {
    await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'country', values: { country: countryCode } })
      .expect(200);
    const vatResponse = await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'vat_tax', values: { vat_tax_registration: vat } })
      .expect(200);
    return { version: vatResponse.body.version as number };
  }

  // Drives all seven wizard steps (pristine -> accounting_setup) through the real HTTP
  // PUT surface, mirroring the all-seven-steps case above — used by every T055 case that
  // needs a genuinely complete, persisted set of required fields before completing/
  // editing settings.
  async function completeAllSevenStepsAndSeedIndustry(): Promise<{ industryId: number }> {
    const industryIds = (await odoo.executeKw(
      tenantDb,
      odooUid,
      odooPassword,
      'res.partner.industry',
      'search',
      [[]],
      { limit: 1 },
    )) as number[];
    const industryId = industryIds[0];
    const steps: Array<{ step: string; values: Record<string, unknown> }> = [
      { step: 'country', values: { country: 'AE' } },
      { step: 'identity', values: { legal_name: 'Acme FZ', trade_name: 'Acme' } },
      { step: 'currency', values: { base_currency: 'AED' } },
      { step: 'fiscal_year', values: { fiscal_year_start_month: '1', fiscal_year_start_day: 1 } },
      { step: 'vat_tax', values: { vat_tax_registration: '1'.repeat(15) } },
      { step: 'industry', values: { industry: industryId } },
      { step: 'accounting_setup', values: { accounting_setup_template: 'standard' } },
    ];
    for (const { step, values } of steps) {
      await request(app.getHttpServer())
        .put('/companies/current/setup')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-KEMFAI-Setup-Scope', scope)
        .send({ step, values })
        .expect(200);
    }
    return { industryId };
  }

  async function countAuditEvents(action: string): Promise<number> {
    const rows = await controlDataSource.query(
      'SELECT count(*)::int AS count FROM audit_event WHERE tenant_id = $1 AND action = $2',
      [tenantId, action],
    );
    return rows[0].count as number;
  }

  // This run's own tenant/action rows only (never another tenant's) — gives each
  // completion/settings case below an isolated starting count, independent of what any
  // earlier case in this suite appended.
  async function clearAuditEvents(action: string): Promise<void> {
    await controlDataSource.query('DELETE FROM audit_event WHERE tenant_id = $1 AND action = $2', [
      tenantId,
      action,
    ]);
  }

  async function setFlagEnabled(enabled: boolean): Promise<void> {
    await controlDataSource.query('UPDATE feature_flag SET enabled = $1 WHERE feature_key = $2', [
      enabled,
      'module.company_setup',
    ]);
  }

  async function getFlagEnabled(): Promise<boolean | null> {
    const rows = await controlDataSource.query(
      `SELECT enabled FROM feature_flag WHERE feature_key = $1`,
      ['module.company_setup'],
    );
    return rows.length > 0 ? (rows[0].enabled as boolean) : null;
  }

  beforeAll(async () => {
    tenantDb = process.env.KEMFAI_T054_TENANT_DB ?? '';
    odooLogin = process.env.KEMFAI_TENANT_ADMIN_LOGIN ?? '';
    odooPassword = process.env.KEMFAI_TENANT_ADMIN_PASSWORD ?? '';
    const master = process.env.KEMFAI_ODOO_MASTER_PASSWORD ?? '';
    const preinitialized = process.env.KEMFAI_T054_DB_PREINITIALIZED === '1';
    if (!tenantDb || !odooLogin || !odooPassword || !master) {
      throw new Error('KEMFAI_LIVE_T054 requires KEMFAI_T054_TENANT_DB and Odoo credentials');
    }
    if (!preinitialized) {
      throw new Error(
        'KEMFAI_LIVE_T054 requires KEMFAI_T054_DB_PREINITIALIZED=1: the scratch tenant ' +
          'database must already be created, migrated, and given its admin credentials by ' +
          'an offline bootstrap CLI container before this fixture runs — the list_db=False ' +
          'HTTP container this fixture talks to correctly rejects exp_create_database, so ' +
          'this spec never attempts to create the database itself.',
      );
    }

    odoo = new OdooRpcService(createOdooRpcClient());
    odooUid = await odoo.authenticate(tenantDb, odooLogin, odooPassword);
    await odoo.executeKw(tenantDb, odooUid, odooPassword, 'ir.module.module', 'update_list', []);
    const modules = (await odoo.executeKw(
      tenantDb,
      odooUid,
      odooPassword,
      'ir.module.module',
      'search_read',
      [[['name', 'in', ['kemfai_tenant_core', 'kemfai_company_setup']]]],
      { fields: ['id', 'state'] },
    )) as Array<{ id: number; state: string }>;
    for (const row of modules) {
      if (row.state !== 'installed') {
        await odoo.executeKw(
          tenantDb,
          odooUid,
          odooPassword,
          'ir.module.module',
          'button_immediate_install',
          [[row.id]],
        );
      }
    }
    const aeIds = (await odoo.executeKw(
      tenantDb,
      odooUid,
      odooPassword,
      'res.country',
      'search',
      [[['code', '=', 'AE']]],
      { limit: 1 },
    )) as number[];
    await odoo.executeKw(
      tenantDb,
      odooUid,
      odooPassword,
      'kemfai.company.setup.country.rule',
      'create',
      [{ country_id: aeIds[0], vat_regex: '\\d{15}', vat_format_hint: '1'.repeat(15) }],
    );
    // SA gets its own configured rule, compatible with the same 15-digit VAT value as
    // AE's — used by the genuine different-country/already-persisted-VAT-still-valid case.
    // US deliberately gets no rule (missing-rule config-gap case, already covered below).
    const saIds = (await odoo.executeKw(
      tenantDb,
      odooUid,
      odooPassword,
      'res.country',
      'search',
      [[['code', '=', 'SA']]],
      { limit: 1 },
    )) as number[];
    await odoo.executeKw(
      tenantDb,
      odooUid,
      odooPassword,
      'kemfai.company.setup.country.rule',
      'create',
      [{ country_id: saIds[0], vat_regex: '\\d{15}', vat_format_hint: '3'.repeat(15) }],
    );

    // T056 round-5 binding resolution (item 1) — captured here, BEFORE the tenant row is
    // inserted below, so `odoo_company_id` can be persisted on that row directly: this
    // fixture now exercises the exact same control-plane shape
    // `TenantProvisionProcessor.verifyCompany` produces for a real tenant, which is what
    // lets `CompanyOdooContextService.resolveCompanyTarget` resolve it with zero Odoo
    // RPCs. Also captured once, before any HTTP case below has had a chance to mutate it:
    // the exact raw wizard field values (and version) of this run's owned scratch
    // company, used by resetCompanyToPristine() to give every case below a pristine,
    // order-independent starting point.
    const companyIds = (await odoo.executeKw(
      tenantDb,
      odooUid,
      odooPassword,
      'res.company',
      'search',
      [[]],
      { limit: 1 },
    )) as number[];
    companyId = companyIds[0];
    const companyRows = (await odoo.executeKw(
      tenantDb,
      odooUid,
      odooPassword,
      'res.company',
      'read',
      [[companyId], WIZARD_FIELDS],
    )) as Array<Record<string, unknown>>;
    pristineCompanyFields = companyRows[0];

    if (!controlDataSource.isInitialized) await controlDataSource.initialize();
    await controlDataSource.runMigrations();

    keycloak = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const planRepo = controlDataSource.getRepository(Plan);
    const plan = await planRepo.save(
      planRepo.create({
        name: `plan-t054-${randomUUID()}`,
        published: true,
        monthlyPrice: '10.00',
        annualPrice: '100.00',
        currency: 'USD',
      }),
    );
    planId = plan.id;

    const accountRepo = controlDataSource.getRepository(Account);
    const account = await accountRepo.save(
      accountRepo.create({
        keycloakUserId: KC_OWNER,
        email: `t054-owner-${randomUUID()}@example.com`,
        emailVerified: true,
        selectedPlanId: planId,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
    );
    const tenantRows = await controlDataSource.query(
      `INSERT INTO tenant (account_id, status, odoo_db_name, odoo_company_id, ready_at)
       VALUES ($1, 'Ready'::tenant_status_enum, $2, $3, now()) RETURNING id`,
      [account.id, tenantDb, companyId],
    );
    tenantId = tenantRows[0].id as string;

    await controlDataSource.getRepository(Subscription).save(
      controlDataSource.getRepository(Subscription).create({
        tenantId,
        planId,
        billingCycle: SubscriptionBillingCycle.MONTHLY,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: '2026-01-01',
        currentPeriodEnd: '2026-02-01',
      }),
    );

    ownerToken = await keycloak.signAccessToken({
      sub: KC_OWNER,
      roles: ['WorkspaceOwner'],
      tenantId,
    });
    nonOwnerToken = await keycloak.signAccessToken({
      sub: KC_NON_OWNER,
      roles: ['Support'],
      tenantId,
    });

    originalFlagEnabled = await getFlagEnabled();
    await setFlagEnabled(true);

    const scopeResponse = await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    scope = scopeResponse.body.scope as string;
    if (!scope)
      throw new Error('T056 fixture setup: GET /companies/current/setup returned no scope');
  }, 180000);

  afterAll(async () => {
    // If beforeAll threw before controlDataSource.initialize() ran (e.g. the
    // KEMFAI_T054_DB_PREINITIALIZED guard, or a missing env var), there is no connection to
    // query and nothing this fixture itself wrote to clean up — only app/keycloak teardown
    // below applies.
    const dataSourceReady = controlDataSource.isInitialized;
    try {
      if (dataSourceReady) {
        try {
          if (tenantId) {
            // audit_event.tenant_id -> tenant.id is ON DELETE RESTRICT (fk_audit_event_tenant):
            // this fixture's own audit rows (if any were written by the saves under test) must be
            // removed before the tenant row, or the tenant delete below fails and this cleanup
            // throws before the flag restoration runs. company_mutation_handoff.tenant_id has the
            // same RESTRICT fk (fk_company_mutation_handoff_tenant) for the same reason.
            await controlDataSource.query('DELETE FROM audit_event WHERE tenant_id = $1', [
              tenantId,
            ]);
            await controlDataSource.query(
              'DELETE FROM company_mutation_handoff WHERE tenant_id = $1',
              [tenantId],
            );
            await controlDataSource.query('DELETE FROM subscription WHERE tenant_id = $1', [
              tenantId,
            ]);
            await controlDataSource.query('DELETE FROM tenant WHERE id = $1', [tenantId]);
          }
          await controlDataSource.query('DELETE FROM account WHERE keycloak_user_id = $1', [
            KC_OWNER,
          ]);
          if (planId) await controlDataSource.query('DELETE FROM plan WHERE id = $1', [planId]);
        } finally {
          // Restore whatever this suite found the flag at, not an unconditional `false` — so an
          // earlier failure above (e.g. a leftover FK row this fixture didn't anticipate) can
          // never leave the flag in a state this suite itself chose rather than the one it found.
          if (originalFlagEnabled !== null) {
            await setFlagEnabled(originalFlagEnabled);
          }
        }
      }
    } finally {
      await app?.close();
      await keycloak?.close();
      if (controlDataSource.isInitialized) await controlDataSource.destroy();
      delete process.env.KEYCLOAK_ISSUER;
      delete process.env.KEYCLOAK_API_AUDIENCE;
      delete process.env.KEYCLOAK_JWKS_URI;
    }
  }, 60000);

  it('owner guard: a non-WorkspaceOwner role is denied (403) for both UI-shaped and raw GET/PUT', async () => {
    await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${nonOwnerToken}`)
      .set('Accept', 'application/json')
      .expect(403);
    await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${nonOwnerToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${nonOwnerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .set('Accept', 'application/json')
      .send({ step: 'country', values: { country: 'AE' } })
      .expect(403);
    await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${nonOwnerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'country', values: { country: 'AE' } })
      .expect(403);
  });

  it('tenant guard: a spoofed x-tenant-id header is denied (403) for both UI-shaped and raw GET/PUT', async () => {
    const otherTenant = randomUUID();
    await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('x-tenant-id', otherTenant)
      .set('Accept', 'application/json')
      .expect(403);
    await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('x-tenant-id', otherTenant)
      .expect(403);
    await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .set('x-tenant-id', otherTenant)
      .set('Accept', 'application/json')
      .send({ step: 'country', values: { country: 'AE' } })
      .expect(403);
    await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .set('x-tenant-id', otherTenant)
      .send({ step: 'country', values: { country: 'AE' } })
      .expect(403);
  });

  it('feature flag guard: disabled flag hides the route (404) for both UI-shaped and raw GET/PUT', async () => {
    await setFlagEnabled(false);
    try {
      await request(app.getHttpServer())
        .get('/companies/current/setup')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Accept', 'application/json')
        .expect(404);
      await request(app.getHttpServer())
        .get('/companies/current/setup')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);
      await request(app.getHttpServer())
        .put('/companies/current/setup')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-KEMFAI-Setup-Scope', scope)
        .set('Accept', 'application/json')
        .send({ step: 'country', values: { country: 'AE' } })
        .expect(404);
      await request(app.getHttpServer())
        .put('/companies/current/setup')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-KEMFAI-Setup-Scope', scope)
        .send({ step: 'country', values: { country: 'AE' } })
        .expect(404);
    } finally {
      // Independent of the try body's outcome: this fixture's flag state must not leak
      // into later tests in this file, which all assume the flag is enabled.
      await setFlagEnabled(true);
    }
  });

  it('trial guard: an elapsed unpaid trial denies (403) both UI-shaped and raw GET/PUT', async () => {
    await controlDataSource.query(
      "UPDATE subscription SET status = 'PendingActivation'::subscription_status_enum WHERE tenant_id = $1",
      [tenantId],
    );
    await controlDataSource.query('UPDATE tenant SET ready_at = $1 WHERE id = $2', [
      new Date(Date.now() - 20 * MS_PER_DAY),
      tenantId,
    ]);
    try {
      await request(app.getHttpServer())
        .get('/companies/current/setup')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Accept', 'application/json')
        .expect(403);
      await request(app.getHttpServer())
        .get('/companies/current/setup')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .put('/companies/current/setup')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-KEMFAI-Setup-Scope', scope)
        .set('Accept', 'application/json')
        .send({ step: 'country', values: { country: 'AE' } })
        .expect(403);
      await request(app.getHttpServer())
        .put('/companies/current/setup')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-KEMFAI-Setup-Scope', scope)
        .send({ step: 'country', values: { country: 'AE' } })
        .expect(403);
    } finally {
      // Independent of the try body's outcome: later tests in this file assume an
      // active, non-expired trial/subscription window.
      await controlDataSource.query(
        "UPDATE subscription SET status = 'Active'::subscription_status_enum WHERE tenant_id = $1",
        [tenantId],
      );
      await controlDataSource.query('UPDATE tenant SET ready_at = now() WHERE id = $1', [tenantId]);
    }
  });

  it('GET resumes at the country step on a fresh company, version 0, not stale', async () => {
    await resetCompanyToPristine();
    const response = await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(response.body).toMatchObject({
      currentStep: 'country',
      setupComplete: false,
      version: 0,
      stale: false,
    });
  });

  it('PUT required-field failure: blank legal_name on the identity step is rejected (422)', async () => {
    await resetCompanyToPristine();
    await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'identity', values: { legal_name: '', trade_name: 'Acme' } })
      .expect(422);
  });

  // T056 round-5 binding resolution (item 5) — the three required contract negatives,
  // proven here against the REAL app (real global ValidationPipe, real guards) with a
  // direct Odoo read proving the rejected envelope never reached the mutation RPC at
  // all, not merely that the HTTP response was a non-2xx.
  it('PUT an unknown "step" value is rejected (422) and never reaches Odoo', async () => {
    await resetCompanyToPristine();
    await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'not_a_real_step', values: {} })
      .expect(422);

    const afterRejection = (await odoo.executeKw(
      tenantDb,
      odooUid,
      odooPassword,
      'res.company',
      'read',
      [[companyId], ['setup_wizard_version']],
    )) as Array<{ setup_wizard_version: number }>;
    expect(afterRejection[0].setup_wizard_version).toBe(0);
  });

  it('PUT a negative "baseVersion" is rejected (422) and never reaches Odoo', async () => {
    await resetCompanyToPristine();
    await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'country', values: { country: 'AE' }, baseVersion: -1 })
      .expect(422);

    const afterRejection = (await odoo.executeKw(
      tenantDb,
      odooUid,
      odooPassword,
      'res.company',
      'read',
      [[companyId], ['country_id', 'setup_wizard_version']],
    )) as Array<{ country_id: unknown; setup_wizard_version: number }>;
    expect(afterRejection[0].country_id).toBe(false);
    expect(afterRejection[0].setup_wizard_version).toBe(0);
  });

  it('PUT a non-integer "baseVersion" is rejected (422) and never reaches Odoo', async () => {
    await resetCompanyToPristine();
    await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'country', values: { country: 'AE' }, baseVersion: 1.5 })
      .expect(422);

    const afterRejection = (await odoo.executeKw(
      tenantDb,
      odooUid,
      odooPassword,
      'res.company',
      'read',
      [[companyId], ['country_id', 'setup_wizard_version']],
    )) as Array<{ country_id: unknown; setup_wizard_version: number }>;
    expect(afterRejection[0].country_id).toBe(false);
    expect(afterRejection[0].setup_wizard_version).toBe(0);
  });

  it('PUT invalid country code is rejected (422)', async () => {
    await resetCompanyToPristine();
    await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'country', values: { country: 'ZZ' } })
      .expect(422);
  });

  it('PUT country with a configured rule persists, advances resume, and bumps version', async () => {
    await resetCompanyToPristine();
    const response = await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'country', values: { country: 'AE' }, baseVersion: 0 })
      .expect(200);
    expect(response.body).toMatchObject({
      currentStep: 'identity',
      values: { country: 'AE' },
      version: 1,
      stale: false,
    });

    const getResponse = await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(getResponse.body).toMatchObject({ currentStep: 'identity', version: 1 });
  });

  it('PUT a stale baseVersion still commits the field but reports stale=true', async () => {
    // This case's own precondition: reset to pristine, then genuinely advance past the
    // country step via real HTTP so the locked version is known (1) before the
    // deliberately-stale baseVersion:0 identity save below — never inherited from
    // whatever version an earlier case happened to leave the company at.
    await resetCompanyToPristine();
    const countryResponse = await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'country', values: { country: 'AE' } })
      .expect(200);
    expect(countryResponse.body.version).toBe(1);

    const response = await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({
        step: 'identity',
        values: { legal_name: 'Acme FZ', trade_name: 'Acme' },
        baseVersion: 0,
      })
      .expect(200);
    expect(response.body).toMatchObject({
      version: 2,
      stale: true,
      values: { legal_name: 'Acme FZ' },
    });
  });

  it('T056 — a stale X-KEMFAI-Setup-Scope header is rejected with 412 BEFORE the Odoo mutation runs; a matching one is accepted', async () => {
    await resetCompanyToPristine();
    const getResponse = await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const realScope = getResponse.body.scope as string;
    expect(typeof realScope).toBe('string');
    expect(realScope.length).toBeGreaterThan(0);

    // A scope computed for a different (nonexistent) tenant/account/company — stands in
    // for "the Alpha scope this browser still holds after the authenticated session
    // actually moved to a different tenant/company (Beta)". Must be rejected before any
    // Odoo write, not merely detected after one.
    const staleScope = Buffer.from('stale-alpha-scope-does-not-match').toString('base64url');

    const rejected = await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .set('X-KEMFAI-Setup-Scope', staleScope)
      .send({ step: 'country', values: { country: 'AE' } })
      .expect(412);
    expect(rejected.body.statusCode).toBe(412);

    // Proof the rejected call never reached Odoo: a direct RPC read of the live company
    // still shows no country persisted and version still at the pristine GET's value.
    const afterRejection = (await odoo.executeKw(
      tenantDb,
      odooUid,
      odooPassword,
      'res.company',
      'read',
      [[companyId], ['country_id', 'setup_wizard_version']],
    )) as Array<{ country_id: unknown; setup_wizard_version: number }>;
    expect(afterRejection[0].country_id).toBe(false);
    expect(afterRejection[0].setup_wizard_version).toBe(getResponse.body.version);

    // The REAL scope, echoed back, is accepted and the mutation proceeds normally.
    const accepted = await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .set('X-KEMFAI-Setup-Scope', realScope)
      .send({ step: 'country', values: { country: 'AE' } })
      .expect(200);
    expect(accepted.body.version).toBe(getResponse.body.version + 1);
  });

  it('PUT and GET-resume persist across all seven wizard steps in fixed order', async () => {
    await resetCompanyToPristine();
    const industryIds = (await odoo.executeKw(
      tenantDb,
      odooUid,
      odooPassword,
      'res.partner.industry',
      'search',
      [[]],
      { limit: 1 },
    )) as number[];
    const industryId = industryIds[0];

    const steps: Array<{ step: string; values: Record<string, unknown> }> = [
      { step: 'country', values: { country: 'AE' } },
      { step: 'identity', values: { legal_name: 'Acme FZ', trade_name: 'Acme' } },
      { step: 'currency', values: { base_currency: 'AED' } },
      { step: 'fiscal_year', values: { fiscal_year_start_month: '1', fiscal_year_start_day: 1 } },
      { step: 'vat_tax', values: { vat_tax_registration: '1'.repeat(15) } },
      { step: 'industry', values: { industry: industryId } },
      { step: 'accounting_setup', values: { accounting_setup_template: 'standard' } },
    ];
    const expectedNextStep = [
      'identity',
      'currency',
      'fiscal_year',
      'vat_tax',
      'industry',
      'accounting_setup',
      'accounting_setup',
    ];

    for (let i = 0; i < steps.length; i += 1) {
      const { step, values } = steps[i];
      const putResponse = await request(app.getHttpServer())
        .put('/companies/current/setup')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-KEMFAI-Setup-Scope', scope)
        .send({ step, values })
        .expect(200);
      expect(putResponse.body.currentStep).toBe(expectedNextStep[i]);
      expect(putResponse.body.stale).toBe(false);

      const getResponse = await request(app.getHttpServer())
        .get('/companies/current/setup')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(getResponse.body.currentStep).toBe(expectedNextStep[i]);
      expect(getResponse.body.version).toBe(putResponse.body.version);
    }

    const finalGet = await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(finalGet.body.values).toMatchObject({
      country: 'AE',
      legal_name: 'Acme FZ',
      trade_name: 'Acme',
      base_currency: 'AED',
      fiscal_year_start_month: '1',
      fiscal_year_start_day: 1,
      vat_tax_registration: '1'.repeat(15),
      industry: industryId,
      accounting_setup_template: 'standard',
    });
  });

  it('PUT country change to a second ruled country (SA) with an already-persisted VAT persists, is not stale, and GET-resumes with the revalidated value', async () => {
    // Seeds its own AE country + VAT through the real API first (never inherited from a
    // previous case), verifies that VAT is genuinely persisted BEFORE the country change,
    // then exercises the actual case under test: changing to a second ruled country (SA)
    // with that already-persisted VAT.
    await resetCompanyToPristine();
    const { version: seededVersion } = await seedCountryAndVat('AE', '1'.repeat(15));

    const before = await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(before.body).toMatchObject({
      version: seededVersion,
      values: { country: 'AE', vat_tax_registration: '1'.repeat(15) },
    });
    const baseVersion = before.body.version as number;

    const response = await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'country', values: { country: 'SA' }, baseVersion })
      .expect(200);
    expect(response.body).toMatchObject({
      stale: false,
      version: baseVersion + 1,
      values: { country: 'SA', vat_tax_registration: '1'.repeat(15) },
    });

    const getResponse = await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(getResponse.body).toMatchObject({
      version: baseVersion + 1,
      stale: false,
      values: { country: 'SA', vat_tax_registration: '1'.repeat(15) },
    });
  });

  it('PUT country change to one with no configured VAT rule is blocked with 409 (existing VAT revalidated)', async () => {
    // Seeds its own AE country + VAT through the real API first (never inherited from a
    // previous case, e.g. the SA case above) so the rollback assertion below checks a
    // genuinely this-case-owned "previous country", not a leftover from another test.
    await resetCompanyToPristine();
    await seedCountryAndVat('AE', '1'.repeat(15));

    await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'country', values: { country: 'US' } })
      .expect(409);

    // Blocked write rolled back: country must remain this case's own previously seeded
    // value (AE), not US.
    const getResponse = await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(getResponse.body.values).toMatchObject({ country: 'AE' });
  });

  // -- T055: POST /companies/current/setup/complete (FR-028, Acceptance Scenario 3.7) --

  it('owner/tenant/feature/trial guards deny POST /companies/current/setup/complete exactly like GET/PUT', async () => {
    await request(app.getHttpServer())
      .post('/companies/current/setup/complete')
      .set('Authorization', `Bearer ${nonOwnerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .expect(403);

    const otherTenant = randomUUID();
    await request(app.getHttpServer())
      .post('/companies/current/setup/complete')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .set('x-tenant-id', otherTenant)
      .expect(403);

    await setFlagEnabled(false);
    try {
      await request(app.getHttpServer())
        .post('/companies/current/setup/complete')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-KEMFAI-Setup-Scope', scope)
        .expect(404);
    } finally {
      await setFlagEnabled(true);
    }

    await controlDataSource.query(
      "UPDATE subscription SET status = 'PendingActivation'::subscription_status_enum WHERE tenant_id = $1",
      [tenantId],
    );
    await controlDataSource.query('UPDATE tenant SET ready_at = $1 WHERE id = $2', [
      new Date(Date.now() - 20 * MS_PER_DAY),
      tenantId,
    ]);
    try {
      await request(app.getHttpServer())
        .post('/companies/current/setup/complete')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-KEMFAI-Setup-Scope', scope)
        .expect(403);
    } finally {
      await controlDataSource.query(
        "UPDATE subscription SET status = 'Active'::subscription_status_enum WHERE tenant_id = $1",
        [tenantId],
      );
      await controlDataSource.query('UPDATE tenant SET ready_at = now() WHERE id = $1', [tenantId]);
    }
  });

  it('completing with required steps still missing is rejected (422) and writes no company.setup.completed audit row', async () => {
    await resetCompanyToPristine();
    await clearAuditEvents('company.setup.completed');
    await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'country', values: { country: 'AE' } })
      .expect(200);

    await request(app.getHttpServer())
      .post('/companies/current/setup/complete')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .expect(422);

    expect(await countAuditEvents('company.setup.completed')).toBe(0);
    const getResponse = await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(getResponse.body.setupComplete).toBe(false);
  });

  it('completing all seven persisted steps marks setup complete and writes exactly one scoped company.setup.completed audit row (Acceptance Scenario 3.7)', async () => {
    await resetCompanyToPristine();
    await clearAuditEvents('company.setup.completed');
    await completeAllSevenStepsAndSeedIndustry();

    const response = await request(app.getHttpServer())
      .post('/companies/current/setup/complete')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .expect(200);
    expect(response.body.setupComplete).toBe(true);

    const rows = await controlDataSource.query(
      `SELECT "action", "subject_type", "tenant_id", "actor_id"
       FROM audit_event WHERE tenant_id = $1 AND action = $2`,
      [tenantId, 'company.setup.completed'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'company.setup.completed',
      subject_type: 'company',
      tenant_id: tenantId,
    });

    const getResponse = await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(getResponse.body.setupComplete).toBe(true);
  });

  it('a repeated completion call is idempotent (200, still complete) and does not write a second audit row', async () => {
    await resetCompanyToPristine();
    await clearAuditEvents('company.setup.completed');
    await completeAllSevenStepsAndSeedIndustry();

    await request(app.getHttpServer())
      .post('/companies/current/setup/complete')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .expect(200);
    expect(await countAuditEvents('company.setup.completed')).toBe(1);

    const second = await request(app.getHttpServer())
      .post('/companies/current/setup/complete')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .expect(200);
    expect(second.body.setupComplete).toBe(true);
    expect(await countAuditEvents('company.setup.completed')).toBe(1);
  });

  // -- T055: GET/PUT /companies/current/settings (FR-028) ------------------------------

  it('owner/tenant/feature/trial guards deny GET/PUT /companies/current/settings exactly like the wizard endpoints', async () => {
    await request(app.getHttpServer())
      .get('/companies/current/settings')
      .set('Authorization', `Bearer ${nonOwnerToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .put('/companies/current/settings')
      .set('Authorization', `Bearer ${nonOwnerToken}`)
      .send({ values: { legal_name: 'X' } })
      .expect(403);

    const otherTenant = randomUUID();
    await request(app.getHttpServer())
      .get('/companies/current/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('x-tenant-id', otherTenant)
      .expect(403);
    await request(app.getHttpServer())
      .put('/companies/current/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('x-tenant-id', otherTenant)
      .send({ values: { legal_name: 'X' } })
      .expect(403);

    await setFlagEnabled(false);
    try {
      await request(app.getHttpServer())
        .get('/companies/current/settings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);
      await request(app.getHttpServer())
        .put('/companies/current/settings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ values: { legal_name: 'X' } })
        .expect(404);
    } finally {
      await setFlagEnabled(true);
    }

    // T055 remediation (prior review finding): this case's title has claimed "trial"
    // coverage since it was written, but no sub-case here ever actually elapsed the
    // trial/removed the active subscription — the assertion below is the genuine one,
    // mirroring the real 'trial guard' case for GET/PUT /companies/current/setup above
    // (same PendingActivation + 20-day-elapsed-ready_at precondition).
    await controlDataSource.query(
      "UPDATE subscription SET status = 'PendingActivation'::subscription_status_enum WHERE tenant_id = $1",
      [tenantId],
    );
    await controlDataSource.query('UPDATE tenant SET ready_at = $1 WHERE id = $2', [
      new Date(Date.now() - 20 * MS_PER_DAY),
      tenantId,
    ]);
    try {
      await request(app.getHttpServer())
        .get('/companies/current/settings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .put('/companies/current/settings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ values: { legal_name: 'X' } })
        .expect(403);
    } finally {
      // Independent of the try body's outcome: later tests in this file assume an
      // active, non-expired trial/subscription window.
      await controlDataSource.query(
        "UPDATE subscription SET status = 'Active'::subscription_status_enum WHERE tenant_id = $1",
        [tenantId],
      );
      await controlDataSource.query('UPDATE tenant SET ready_at = now() WHERE id = $1', [tenantId]);
    }
  });

  it('GET/PUT /companies/current/settings before setup is complete are both rejected with the canonical 409 CompanySetupIncompleteError', async () => {
    await resetCompanyToPristine();
    await request(app.getHttpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'country', values: { country: 'AE' } })
      .expect(200);

    const getResponse = await request(app.getHttpServer())
      .get('/companies/current/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);
    expect(getResponse.body).toMatchObject({ statusCode: 409, setupComplete: false });

    const putResponse = await request(app.getHttpServer())
      .put('/companies/current/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ values: { legal_name: 'Should Not Persist' } })
      .expect(409);
    expect(putResponse.body).toMatchObject({ statusCode: 409, setupComplete: false });

    const wizardGet = await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(wizardGet.body.values.legal_name).toBeFalsy();
  });

  it('after completion, settings GET/PUT edit persisted values WITHOUT re-running the wizard, and the wizard/version integrity is untouched (FR-028)', async () => {
    await resetCompanyToPristine();
    await clearAuditEvents('company.settings.updated');
    await completeAllSevenStepsAndSeedIndustry();
    const completeResponse = await request(app.getHttpServer())
      .post('/companies/current/setup/complete')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .expect(200);
    const versionAfterComplete = completeResponse.body.version as number;

    const settingsBefore = await request(app.getHttpServer())
      .get('/companies/current/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(settingsBefore.body).toMatchObject({
      setupComplete: true,
      values: { legal_name: 'Acme FZ' },
    });

    const settingsPut = await request(app.getHttpServer())
      .put('/companies/current/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ values: { legal_name: 'Acme Holdings FZ' } })
      .expect(200);
    expect(settingsPut.body).toMatchObject({
      setupComplete: true,
      values: { legal_name: 'Acme Holdings FZ' },
    });

    // Durably persisted — a fresh GET (not just the PUT's own response) reflects it.
    const settingsAfter = await request(app.getHttpServer())
      .get('/companies/current/settings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(settingsAfter.body.values).toMatchObject({ legal_name: 'Acme Holdings FZ' });

    // Exactly one company.settings.updated audit row for this edit — distinct action
    // from company.setup.completed, never reusing/duplicating it.
    expect(await countAuditEvents('company.settings.updated')).toBe(1);

    // The settings edit never re-entered the wizard's step/version bookkeeping: the
    // wizard's own version is unchanged by a pure settings PUT, and setup_complete
    // stays true — this edit happened WITHOUT re-running the wizard, per FR-028.
    const wizardGet = await request(app.getHttpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(wizardGet.body.version).toBe(versionAfterComplete);
    expect(wizardGet.body.setupComplete).toBe(true);
    expect(wizardGet.body.values.legal_name).toBe('Acme Holdings FZ');
  });
});
