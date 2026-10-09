import { randomUUID } from 'node:crypto';
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
import { OpenApiContractValidator } from '../support/openapi-contract-validator';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

/**
 * T050 live integration proof. The owning runner creates fresh labelled PostgreSQL,
 * Redis, and Odoo containers plus disposable control/tenant databases before enabling
 * this suite with KEMFAI_LIVE_T050=1. All requests pass through the production NestJS
 * guards/controller/service, the production JSON-RPC transport, and the real Odoo addon.
 */
const live = process.env.KEMFAI_LIVE_T050 === '1' ? describe : describe.skip;

live('T050 country-dependent company VAT/tax validation', () => {
  const path = '/companies/current/setup';
  const issuer = 'http://127.0.0.1/realms/kemfai-customers-t050';
  const audience = 'kemfai-api-t050';
  const ownerSubject = '50000000-0000-4000-8000-000000000001';
  const foreignOwnerSubject = '50000000-0000-4000-8000-000000000002';
  const supportSubject = '50000000-0000-4000-8000-000000000003';
  const contract = new OpenApiContractValidator();

  let app: INestApplication;
  let keycloak: FakeKeycloak;
  let odoo: OdooRpcService;
  let tenantDb: string;
  let odooUid: number;
  let odooPassword: string;
  let companyId: number;
  let pristineCompanyFields: Record<string, unknown>;
  let ownerAccountId: string;
  let foreignAccountId: string;
  let tenantId: string;
  let foreignTenantId: string;
  let planId: string;
  let ownerToken: string;
  let foreignOwnerToken: string;
  let supportToken: string;
  let scope: string;
  let redMutationRuleId: number | null = null;
  let originalFlagEnabled: boolean | null = null;

  const wizardFields = [
    'country',
    'vat_tax_registration',
    'setup_wizard_step',
    'setup_complete',
    'setup_completed_at',
    'setup_wizard_version',
  ];

  function normalizeMany2one(value: unknown): unknown {
    return Array.isArray(value) ? value[0] : value;
  }

  async function resetCompany(): Promise<void> {
    const values: Record<string, unknown> = {};
    for (const field of wizardFields) {
      values[field] = normalizeMany2one(pristineCompanyFields[field]);
    }
    await odoo.executeKw(tenantDb, odooUid, odooPassword, 'res.company', 'write', [
      [companyId],
      values,
    ]);
    await controlDataSource.query(
      `DELETE FROM idempotency_key WHERE idempotency_key LIKE 't050-%'`,
    );
  }

  async function currentCompanyState(): Promise<{
    country: unknown;
    vat_tax_registration: unknown;
    setup_wizard_version: number;
  }> {
    const rows = (await odoo.executeKw(tenantDb, odooUid, odooPassword, 'res.company', 'read', [
      [companyId],
      ['country', 'vat_tax_registration', 'setup_wizard_version'],
    ])) as Array<{
      country: unknown;
      vat_tax_registration: unknown;
      setup_wizard_version: number;
    }>;
    return rows[0];
  }

  function assertErrorSchema(body: unknown, status: number, message: RegExp): void {
    contract.validateComponentSchema('NestErrorResponse', body);
    expect(body).toEqual(
      expect.objectContaining({
        statusCode: status,
        message: expect.any(String),
        error: expect.any(String),
      }),
    );
    expect((body as { message: string }).message).toMatch(message);
  }

  function saveCountry(country: string, idempotencyKey?: string) {
    let operation = request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope);
    if (idempotencyKey) operation = operation.set('Idempotency-Key', idempotencyKey);
    return operation.send({ step: 'country', values: { country } });
  }

  function saveVat(value: string, idempotencyKey?: string) {
    let operation = request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope);
    if (idempotencyKey) operation = operation.set('Idempotency-Key', idempotencyKey);
    return operation.send({ step: 'vat_tax', values: { vat_tax_registration: value } });
  }

  beforeAll(async () => {
    tenantDb = process.env.KEMFAI_T050_TENANT_DB ?? '';
    const odooLogin = process.env.KEMFAI_TENANT_ADMIN_LOGIN ?? '';
    odooPassword = process.env.KEMFAI_TENANT_ADMIN_PASSWORD ?? '';
    if (
      !tenantDb ||
      !odooLogin ||
      !odooPassword ||
      process.env.KEMFAI_T050_DB_PREINITIALIZED !== '1'
    ) {
      throw new Error('T050 live fixture requires its preinitialized private tenant database');
    }

    odoo = new OdooRpcService(createOdooRpcClient());
    odooUid = await odoo.authenticate(tenantDb, odooLogin, odooPassword);
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
      [[companyId], wizardFields],
    )) as Array<Record<string, unknown>>;
    pristineCompanyFields = companyRows[0];

    for (const [countryCode, regex, hint] of [
      ['AE', '\\d{15}', '111111111111111'],
      ['SA', '[A-Z]{3}-\\d{4}', 'ABC-1234'],
    ]) {
      const countryIds = (await odoo.executeKw(
        tenantDb,
        odooUid,
        odooPassword,
        'res.country',
        'search',
        [[['code', '=', countryCode]]],
        { limit: 1 },
      )) as number[];
      const existingRuleIds = (await odoo.executeKw(
        tenantDb,
        odooUid,
        odooPassword,
        'kemfai.company.setup.country.rule',
        'search',
        [[['country_id', '=', countryIds[0]]]],
        { limit: 1 },
      )) as number[];
      if (existingRuleIds.length === 0) {
        await odoo.executeKw(
          tenantDb,
          odooUid,
          odooPassword,
          'kemfai.company.setup.country.rule',
          'create',
          [{ country_id: countryIds[0], vat_regex: regex, vat_format_hint: hint }],
        );
      }
    }

    // Red-proof mode is runner-only and disposable: deliberately filling the otherwise
    // absent US rule must make the 409 assertion fail. The ordinary green run never sets it.
    if (process.env.KEMFAI_T050_RED_MUTATION === 'seed-missing-rule') {
      const usIds = (await odoo.executeKw(
        tenantDb,
        odooUid,
        odooPassword,
        'res.country',
        'search',
        [[['code', '=', 'US']]],
        { limit: 1 },
      )) as number[];
      redMutationRuleId = (await odoo.executeKw(
        tenantDb,
        odooUid,
        odooPassword,
        'kemfai.company.setup.country.rule',
        'create',
        [{ country_id: usIds[0], vat_regex: '.*', vat_format_hint: 'configured-for-red-proof' }],
      )) as number;
    }

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
        name: `plan-t050-${randomUUID()}`,
        published: true,
        monthlyPrice: '10.00',
        annualPrice: '100.00',
        currency: 'USD',
      }),
    );
    planId = plan.id;

    const accountRepo = controlDataSource.getRepository(Account);
    const owner = await accountRepo.save(
      accountRepo.create({
        keycloakUserId: ownerSubject,
        email: `t050-owner-${randomUUID()}@example.invalid`,
        emailVerified: true,
        selectedPlanId: planId,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
    );
    ownerAccountId = owner.id;
    const foreignOwner = await accountRepo.save(
      accountRepo.create({
        keycloakUserId: foreignOwnerSubject,
        email: `t050-foreign-${randomUUID()}@example.invalid`,
        emailVerified: true,
        selectedPlanId: planId,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
    );
    foreignAccountId = foreignOwner.id;

    const ownerTenantRows = await controlDataSource.query(
      `INSERT INTO tenant (account_id, status, odoo_db_name, odoo_company_id, ready_at)
       VALUES ($1, 'Ready'::tenant_status_enum, $2, $3, now()) RETURNING id`,
      [ownerAccountId, tenantDb, companyId],
    );
    tenantId = ownerTenantRows[0].id as string;
    const foreignTenantRows = await controlDataSource.query(
      `INSERT INTO tenant (account_id, status, odoo_db_name, odoo_company_id, ready_at)
       VALUES ($1, 'Ready'::tenant_status_enum, $2, $3, now()) RETURNING id`,
      [foreignAccountId, `${tenantDb}_foreign_unreachable`, companyId],
    );
    foreignTenantId = foreignTenantRows[0].id as string;

    const subscriptionRepo = controlDataSource.getRepository(Subscription);
    await subscriptionRepo.save(
      subscriptionRepo.create({
        tenantId,
        planId,
        billingCycle: SubscriptionBillingCycle.MONTHLY,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: '2026-01-01',
        currentPeriodEnd: '2026-02-01',
      }),
    );

    const flagRows = await controlDataSource.query(
      `SELECT enabled FROM feature_flag WHERE feature_key = 'module.company_setup'`,
    );
    originalFlagEnabled = flagRows.length ? (flagRows[0].enabled as boolean) : null;
    await controlDataSource.query(
      `UPDATE feature_flag SET enabled = true WHERE feature_key = 'module.company_setup'`,
    );

    ownerToken = await keycloak.signAccessToken({
      sub: ownerSubject,
      roles: ['WorkspaceOwner'],
      tenantId,
    });
    foreignOwnerToken = await keycloak.signAccessToken({
      sub: foreignOwnerSubject,
      roles: ['WorkspaceOwner'],
      tenantId: foreignTenantId,
    });
    supportToken = await keycloak.signAccessToken({
      sub: supportSubject,
      roles: ['Support'],
      tenantId,
    });

    const response = await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    scope = response.body.scope as string;
  }, 180_000);

  beforeEach(async () => {
    await resetCompany();
  });

  afterAll(async () => {
    try {
      if (redMutationRuleId) {
        await odoo.executeKw(
          tenantDb,
          odooUid,
          odooPassword,
          'kemfai.company.setup.country.rule',
          'unlink',
          [[redMutationRuleId]],
        );
      }
      if (controlDataSource.isInitialized) {
        await controlDataSource.query(
          `DELETE FROM idempotency_key WHERE idempotency_key LIKE 't050-%'`,
        );
        await controlDataSource.query('DELETE FROM audit_event WHERE tenant_id IN ($1, $2)', [
          tenantId,
          foreignTenantId,
        ]);
        await controlDataSource.query('DELETE FROM subscription WHERE tenant_id = $1', [tenantId]);
        await controlDataSource.query('DELETE FROM tenant WHERE id IN ($1, $2)', [
          tenantId,
          foreignTenantId,
        ]);
        await controlDataSource.query('DELETE FROM account WHERE id IN ($1, $2)', [
          ownerAccountId,
          foreignAccountId,
        ]);
        if (planId) await controlDataSource.query('DELETE FROM plan WHERE id = $1', [planId]);
        if (originalFlagEnabled !== null) {
          await controlDataSource.query(
            `UPDATE feature_flag SET enabled = $1 WHERE feature_key = 'module.company_setup'`,
            [originalFlagEnabled],
          );
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
  }, 60_000);

  it.each([
    ['AE', '123456789012345'],
    ['SA', 'ABC-1234'],
  ])('accepts a configured valid %s VAT/tax value through HTTP and Odoo', async (country, vat) => {
    const countryResponse = await saveCountry(country).expect(200);
    contract.assertResponse(path, 'put', 200, countryResponse.body);

    const key = `t050-valid-${country.toLowerCase()}-${randomUUID()}`;
    const accepted = await saveVat(vat, key).expect(200);
    contract.assertResponse(path, 'put', 200, accepted.body);
    expect(accepted.body.values).toMatchObject({
      country,
      vat_tax_registration: vat,
    });

    const replay = await saveVat(vat, key).expect(200);
    expect(replay.body).toEqual(accepted.body);
    const persisted = await currentCompanyState();
    expect(persisted.vat_tax_registration).toBe(vat);
    expect(persisted.setup_wizard_version).toBe(2);
  });

  it.each([
    ['AE', 'ABC-1234'],
    ['SA', '123456789012345'],
  ])(
    'rejects a configured but invalid %s VAT/tax value with schema-conformant 422',
    async (country, vat) => {
      await saveCountry(country).expect(200);
      const before = await currentCompanyState();
      const rejected = await saveVat(vat).expect(422);
      contract.assertResponse(path, 'put', 422, rejected.body);
      assertErrorSchema(rejected.body, 422, /does not match the expected format/i);

      const after = await currentCompanyState();
      expect(after.country).toEqual(before.country);
      expect(after.vat_tax_registration).toBe(false);
      expect(after.setup_wizard_version).toBe(before.setup_wizard_version);
    },
  );

  it('rejects a missing required VAT/tax value with 422 and no persistence', async () => {
    await saveCountry('AE').expect(200);
    const before = await currentCompanyState();
    const rejected = await saveVat('').expect(422);
    contract.assertResponse(path, 'put', 422, rejected.body);
    assertErrorSchema(rejected.body, 422, /vat_tax_registration is required/i);
    expect(await currentCompanyState()).toEqual(before);
  });

  it('fails closed with schema-conformant 409 when the selected country has no rule', async () => {
    await saveCountry('US').expect(200);
    const before = await currentCompanyState();
    const rejected = await saveVat('12-345').expect(409);
    contract.assertResponse(path, 'put', 409, rejected.body);
    assertErrorSchema(rejected.body, 409, /no VAT\/tax validation rule is configured/i);

    const after = await currentCompanyState();
    expect(after.country).toEqual(before.country);
    expect(after.vat_tax_registration).toBe(false);
    expect(after.setup_wizard_version).toBe(before.setup_wizard_version);
  });

  it('enforces WorkspaceOwner authorization before validation reaches Odoo', async () => {
    const before = await currentCompanyState();
    await request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${supportToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .send({ step: 'country', values: { country: 'AE' } })
      .expect(403);
    expect(await currentCompanyState()).toEqual(before);
  });

  it('denies and source-links a cross-tenant attempt before any Odoo mutation', async () => {
    const before = await currentCompanyState();
    await request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .set('X-Tenant-Id', foreignTenantId)
      .send({ step: 'country', values: { country: 'AE' } })
      .expect(403);
    expect(await currentCompanyState()).toEqual(before);

    const events = await controlDataSource.query(
      `SELECT subject_id, payload
       FROM audit_event
       WHERE tenant_id = $1 AND action = 'tenant_access.denied_cross_tenant'
       ORDER BY occurred_at DESC LIMIT 1`,
      [tenantId],
    );
    expect(events).toHaveLength(1);
    expect(events[0].subject_id).toBe(foreignTenantId);
    expect(events[0].payload).toMatchObject({
      target_tenant_id: foreignTenantId,
      attempted_id: foreignTenantId,
      reference_source: 'header',
    });

    const sourceRows = await controlDataSource.query('SELECT id FROM tenant WHERE id = $1', [
      events[0].subject_id,
    ]);
    expect(sourceRows).toHaveLength(1);
  });

  it('does not let a foreign owner token operate on the owned tenant scope', async () => {
    const before = await currentCompanyState();
    await request(app.getHttpServer())
      .put(path)
      .set('Authorization', `Bearer ${foreignOwnerToken}`)
      .set('X-KEMFAI-Setup-Scope', scope)
      .set('X-Tenant-Id', tenantId)
      .send({ step: 'country', values: { country: 'AE' } })
      .expect(403);
    expect(await currentCompanyState()).toEqual(before);
  });
});
