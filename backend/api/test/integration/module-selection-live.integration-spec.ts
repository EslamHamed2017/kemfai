import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { OdooRpcService } from '../../src/integrations/odoo-rpc/odoo-rpc.service';
import { createOdooRpcClient } from '../../src/integrations/odoo-rpc/odoo-rpc-client';
import { OpenApiContractValidator } from '../support/openapi-contract-validator';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

/**
 * Owned-stack acceptance for T072/T073/T075/T076. The launcher supplies fresh PostgreSQL,
 * Redis, and two Odoo tenant databases. Only identity is synthetic: the local RS256/JWKS
 * issuer still exercises the production BearerAuthGuard network-verification path.
 */
const live = process.env.KEMFAI_LIVE_T072 === '1' ? describe : describe.skip;

interface LiveSelectionReceipt {
  operationUuid: string;
  tenantId: string;
  accountId: string;
  actorKeycloakUserId: string;
  occurredAt: string;
  featureKeys: string[];
  added: string[];
  removed: string[];
}

interface LiveSelectionEvent {
  id: number;
  operation_uuid: string;
  requested_json: string;
  result_json: string;
  added_json: string;
  removed_json: string;
  audited: boolean;
}

function assertSelectionReceipt(value: unknown): asserts value is LiveSelectionReceipt {
  const receipt = value as Partial<LiveSelectionReceipt> | null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const strings = (items: unknown): items is string[] =>
    Array.isArray(items) && items.every((item) => typeof item === 'string');
  if (
    !receipt ||
    typeof receipt.operationUuid !== 'string' ||
    !uuid.test(receipt.operationUuid) ||
    typeof receipt.tenantId !== 'string' ||
    !uuid.test(receipt.tenantId) ||
    typeof receipt.accountId !== 'string' ||
    !uuid.test(receipt.accountId) ||
    typeof receipt.actorKeycloakUserId !== 'string' ||
    !uuid.test(receipt.actorKeycloakUserId) ||
    typeof receipt.occurredAt !== 'string' ||
    !/(?:Z|[+-]\d\d:\d\d)$/.test(receipt.occurredAt) ||
    Number.isNaN(Date.parse(receipt.occurredAt)) ||
    !strings(receipt.featureKeys) ||
    !strings(receipt.added) ||
    !strings(receipt.removed)
  ) {
    throw new Error('Odoo returned an invalid module-selection recovery receipt');
  }
}

function assertSelectionEvents(value: unknown): asserts value is LiveSelectionEvent[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (row: unknown) =>
        typeof row !== 'object' ||
        row === null ||
        typeof (row as Partial<LiveSelectionEvent>).id !== 'number' ||
        typeof (row as Partial<LiveSelectionEvent>).operation_uuid !== 'string' ||
        typeof (row as Partial<LiveSelectionEvent>).requested_json !== 'string' ||
        typeof (row as Partial<LiveSelectionEvent>).result_json !== 'string' ||
        typeof (row as Partial<LiveSelectionEvent>).added_json !== 'string' ||
        typeof (row as Partial<LiveSelectionEvent>).removed_json !== 'string' ||
        typeof (row as Partial<LiveSelectionEvent>).audited !== 'boolean',
    )
  ) {
    throw new Error('Odoo returned invalid module-selection event rows');
  }
}

function parseFeatureKeys(value: string, field: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`Odoo returned invalid ${field}`);
  }
  return [...parsed].sort();
}

function assertNumericIds(value: unknown): asserts value is number[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'number')) {
    throw new Error('Odoo returned invalid module-selection event IDs');
  }
}

live('T072 module selection owned live stack', () => {
  const issuer = 'http://127.0.0.1/realms/t072-local-fixture';
  const audience = 'kemfai-api';
  const ownerSub = '07200000-0000-4000-8000-000000000001';
  const otherSub = '07200000-0000-4000-8000-000000000002';
  const contract = new OpenApiContractValidator();
  let app: INestApplication;
  let keycloak: FakeKeycloak;
  let hostileKeycloak: FakeKeycloak;
  let ownerToken: string;
  let otherToken: string;
  let wrongRoleToken: string;
  let tenantId: string;
  let otherTenantId: string;
  let accountId: string;
  let planId: string;
  let premiumPlanId: string;
  let odoo: OdooRpcService;
  let odooUid: number;
  let db: string;
  let otherDb: string;
  let login: string;
  let password: string;

  const httpPut = (token: string, keys: string[], ui = false) => {
    let call = request(app.getHttpServer())
      .put('/modules/selection')
      .set('Authorization', `Bearer ${token}`);
    if (ui) call = call.set('Origin', 'http://127.0.0.1');
    return call.send({ featureKeys: keys });
  };

  beforeAll(async () => {
    if (process.env.KEMFAI_T072_STACK_OWNED !== '1') {
      throw new Error('KEMFAI_LIVE_T072 requires the exact-owned scripts/test_t072_live.sh stack');
    }
    db = process.env.KEMFAI_T072_TENANT_A_DB ?? '';
    otherDb = process.env.KEMFAI_T072_TENANT_B_DB ?? '';
    login = process.env.KEMFAI_TENANT_ADMIN_LOGIN ?? '';
    password = process.env.KEMFAI_TENANT_ADMIN_PASSWORD ?? '';
    if (!db || !otherDb || !login || !password || db === otherDb) {
      throw new Error('T072 live stack requires two distinct preinitialized tenant databases');
    }
    if (!controlDataSource.isInitialized) await controlDataSource.initialize();
    await controlDataSource.runMigrations();

    keycloak = await startFakeKeycloak({ issuer, audience });
    hostileKeycloak = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;
    process.env.KEMFAI_DISABLE_MODULE_SELECTION_RECOVERY_WORKER = '1';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, errorHttpStatusCode: 422 }));
    await app.init();

    const rows = await controlDataSource.query(
      `WITH plans AS (
         INSERT INTO plan (name,name_en,published,monthly_price,annual_price,currency)
         VALUES ('t072-current','Current',true,10,100,'USD'),('t072-upgrade','Upgrade',true,20,200,'USD')
         RETURNING id,name
       ) SELECT id,name FROM plans`,
    );
    planId = rows.find((row: { name: string }) => row.name === 't072-current').id;
    premiumPlanId = rows.find((row: { name: string }) => row.name === 't072-upgrade').id;
    await controlDataSource.query(
      `INSERT INTO feature (id,key,display_name,display_name_en,kind) VALUES
       (gen_random_uuid(),'module.accounting','Accounting','Accounting','module'),
       (gen_random_uuid(),'module.inventory','Inventory','Inventory','module'),
       (gen_random_uuid(),'report.export','Report export','Report export','limit')
       ON CONFLICT (key) DO UPDATE SET display_name_en=excluded.display_name_en`,
    );
    await controlDataSource.query(
      `INSERT INTO plan_feature_entitlement(plan_id,feature_key,enabled,limit_value)
       VALUES ($1,'module.accounting',true,null),($2,'module.accounting',true,null),
              ($2,'module.inventory',true,null),($1,'report.export',true,100)`,
      [planId, premiumPlanId],
    );
    await controlDataSource.query(
      `INSERT INTO plan_setting(plan_id,trial_window_days,auto_restrict_unpaid)
       VALUES ($1,14,true),($2,14,true)`,
      [planId, premiumPlanId],
    );
    await controlDataSource.query(
      `UPDATE feature_flag SET enabled=true WHERE feature_key='module.module_selection'`,
    );
    const accounts = await controlDataSource.query(
      `INSERT INTO account(keycloak_user_id,email,email_verified,selected_plan_id,selected_billing_cycle)
       VALUES ($1,$3,true,$5,'monthly'),($2,$4,true,$6,'monthly') RETURNING id,keycloak_user_id`,
      [
        ownerSub,
        otherSub,
        `t072-${randomUUID()}@example.invalid`,
        `t072-${randomUUID()}@example.invalid`,
        planId,
        premiumPlanId,
      ],
    );
    accountId = accounts.find(
      (row: { keycloak_user_id: string }) => row.keycloak_user_id === ownerSub,
    ).id;
    const otherAccountId = accounts.find(
      (row: { keycloak_user_id: string }) => row.keycloak_user_id === otherSub,
    ).id;
    const tenants = await controlDataSource.query(
      `INSERT INTO tenant(account_id,status,odoo_db_name,ready_at)
       VALUES ($1,'Ready',$3,now()),($2,'Ready',$4,now()) RETURNING id,account_id`,
      [accountId, otherAccountId, db, otherDb],
    );
    tenantId = tenants.find((row: { account_id: string }) => row.account_id === accountId).id;
    otherTenantId = tenants.find(
      (row: { account_id: string }) => row.account_id === otherAccountId,
    ).id;
    await controlDataSource.query(
      `INSERT INTO subscription(tenant_id,plan_id,billing_cycle,status,current_period_start,current_period_end)
       VALUES ($1,$3,'monthly','Active',current_date,current_date+30),
              ($2,$4,'monthly','Active',current_date,current_date+30)`,
      [tenantId, otherTenantId, planId, premiumPlanId],
    );
    ownerToken = await keycloak.signAccessToken({
      sub: ownerSub,
      roles: ['WorkspaceOwner'],
      tenantId,
    });
    otherToken = await keycloak.signAccessToken({
      sub: otherSub,
      roles: ['WorkspaceOwner'],
      tenantId: otherTenantId,
    });
    wrongRoleToken = await keycloak.signAccessToken({
      sub: ownerSub,
      roles: ['SupportAgent'],
      tenantId,
    });
    odoo = new OdooRpcService(createOdooRpcClient());
    odooUid = await odoo.authenticate(db, login, password);
  }, 180000);

  afterAll(async () => {
    await app?.close();
    await keycloak?.close();
    await hostileKeycloak?.close();
    if (controlDataSource.isInitialized) await controlDataSource.destroy();
    delete process.env.KEYCLOAK_ISSUER;
    delete process.env.KEYCLOAK_API_AUDIENCE;
    delete process.env.KEYCLOAK_JWKS_URI;
    delete process.env.KEMFAI_DISABLE_MODULE_SELECTION_RECOVERY_WORKER;
  });

  it('returns contract-valid actual HTTP options with entitlement-derived upgrade indicators', async () => {
    const response = await request(app.getHttpServer())
      .get('/modules')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    contract.assertResponse('/modules', 'get', response.status, response.body);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'module.accounting',
          includedInCurrentPlan: true,
          requiredPlanTier: null,
        }),
        expect.objectContaining({
          key: 'module.inventory',
          includedInCurrentPlan: false,
          requiredPlanTier: 'Upgrade',
        }),
      ]),
    );
  });

  it('persists entitled selection, reflects immediately, and stores truthful audit/provenance', async () => {
    const response = await httpPut(ownerToken, ['module.accounting'], true).expect(200);
    contract.assertResponse('/modules/selection', 'put', response.status, response.body);
    expect(response.body).toEqual({ featureKeys: ['module.accounting'] });
    expect(
      await odoo.executeKw(
        db,
        odooUid,
        password,
        'kemfai.module.selection',
        'kemfai_get_selection',
        [],
      ),
    ).toEqual(['module.accounting']);
    const audits = await controlDataSource.query(
      `SELECT actor_id,occurred_at,payload,dedupe_key FROM audit_event
       WHERE tenant_id=$1 AND action='modules.selection.changed' ORDER BY occurred_at DESC`,
      [tenantId],
    );
    expect(audits[0].actor_id).toBe(accountId);
    expect(audits[0].payload).toEqual({ added: ['module.accounting'], removed: [] });
    expect(audits[0].dedupe_key).toMatch(/^modules\.selection\.changed:/);
    expect(
      await odoo.executeKw(
        db,
        odooUid,
        password,
        'kemfai.module.selection',
        'kemfai_get_pending_selection_event',
        [],
      ),
    ).toBe(false);
  });

  it('denies UI/raw unentitled, role, cross-tenant, disabled-flag, and bad-signature calls before mutation', async () => {
    for (const ui of [true, false]) {
      const denied = await httpPut(ownerToken, ['module.inventory'], ui).expect(403);
      contract.assertResponse('/modules/selection', 'put', denied.status, denied.body);
    }
    const roleDenied = await httpPut(wrongRoleToken, ['module.accounting']).expect(403);
    contract.assertResponse('/modules/selection', 'put', roleDenied.status, roleDenied.body);
    await httpPut(otherToken, ['module.accounting']).set('x-tenant-id', tenantId).expect(403);
    await controlDataSource.query(
      `UPDATE feature_flag SET enabled=false WHERE feature_key='module.module_selection'`,
    );
    await httpPut(ownerToken, ['module.accounting']).expect(404);
    await controlDataSource.query(
      `UPDATE feature_flag SET enabled=true WHERE feature_key='module.module_selection'`,
    );
    const hostile = await hostileKeycloak.signAccessToken({
      sub: ownerSub,
      roles: ['WorkspaceOwner'],
      tenantId,
    });
    await httpPut(hostile, ['module.accounting']).expect(401);
    expect(
      await odoo.executeKw(
        db,
        odooUid,
        password,
        'kemfai.module.selection',
        'kemfai_get_selection',
        [],
      ),
    ).toEqual(['module.accounting']);
  });

  it('denies an entitled non-module LIMIT key before real Odoo mutation', async () => {
    const denied = await httpPut(ownerToken, ['report.export']).expect(403);
    contract.assertResponse('/modules/selection', 'put', denied.status, denied.body);
    expect(denied.body).toEqual({
      message: 'One or more selected modules require a different plan',
      featureKeys: ['report.export'],
    });
    expect(
      await odoo.executeKw(
        db,
        odooUid,
        password,
        'kemfai.module.selection',
        'kemfai_get_selection',
        [],
      ),
    ).toEqual(['module.accounting']);
  });

  it('denies expired unpaid UI and raw calls', async () => {
    await controlDataSource.query(
      `UPDATE subscription SET status='PendingActivation' WHERE tenant_id=$1`,
      [tenantId],
    );
    await controlDataSource.query(
      `UPDATE tenant SET ready_at=now()-interval '30 days' WHERE id=$1`,
      [tenantId],
    );
    for (const ui of [true, false]) {
      const denied = await httpPut(ownerToken, ['module.accounting'], ui).expect(403);
      contract.assertResponse('/modules/selection', 'put', denied.status, denied.body);
    }
    await controlDataSource.query(`UPDATE subscription SET status='Active' WHERE tenant_id=$1`, [
      tenantId,
    ]);
  });

  it('keeps the second tenant database physically isolated', async () => {
    await httpPut(otherToken, ['module.inventory']).expect(200);
    const otherUid = await odoo.authenticate(otherDb, login, password);
    expect(
      await odoo.executeKw(
        otherDb,
        otherUid,
        password,
        'kemfai.module.selection',
        'kemfai_get_selection',
        [],
      ),
    ).toEqual(['module.inventory']);
    expect(
      await odoo.executeKw(
        db,
        odooUid,
        password,
        'kemfai.module.selection',
        'kemfai_get_selection',
        [],
      ),
    ).toEqual(['module.accounting']);
  });

  it('recovers an Odoo-committed receipt after audit failure without replaying HTTP', async () => {
    await controlDataSource.query('ALTER TABLE audit_event RENAME TO audit_event_t072_fault');
    try {
      await httpPut(ownerToken, []).expect(500);
    } finally {
      await controlDataSource.query('ALTER TABLE audit_event_t072_fault RENAME TO audit_event');
    }
    const receipt = await odoo.executeKw(
      db,
      odooUid,
      password,
      'kemfai.module.selection',
      'kemfai_get_pending_selection_event',
      [],
    );
    assertSelectionReceipt(receipt);
    expect(receipt).toEqual(
      expect.objectContaining({
        tenantId,
        accountId,
        actorKeycloakUserId: ownerSub,
        removed: ['module.accounting'],
      }),
    );
    // Rebuild the production AppModule and allow its feature-local startup worker to recover
    // autonomously. No original HTTP request is replayed and the worker uses receipt provenance.
    await app.close();
    delete process.env.KEMFAI_DISABLE_MODULE_SELECTION_RECOVERY_WORKER;
    const restartedModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = restartedModule.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, errorHttpStatusCode: 422 }));
    await app.init();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const pending = await odoo.executeKw(
        db,
        odooUid,
        password,
        'kemfai.module.selection',
        'kemfai_get_pending_selection_event',
        [],
      );
      if (pending === false) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(
      await odoo.executeKw(
        db,
        odooUid,
        password,
        'kemfai.module.selection',
        'kemfai_get_pending_selection_event',
        [],
      ),
    ).toBe(false);
    const rows = await controlDataSource.query(
      `SELECT count(*)::int count FROM audit_event WHERE dedupe_key=$1`,
      [`modules.selection.changed:${receipt.operationUuid}`],
    );
    expect(rows[0].count).toBe(1);
  });

  it('serializes concurrent A/B/A replacements without stale or duplicate audit deltas', async () => {
    const baseline = await httpPut(ownerToken, []).expect(200);
    contract.assertResponse('/modules/selection', 'put', baseline.status, baseline.body);
    expect(baseline.body).toEqual({ featureKeys: [] });
    expect(
      await odoo.executeKw(
        db,
        odooUid,
        password,
        'kemfai.module.selection',
        'kemfai_get_selection',
        [],
      ),
    ).toEqual([]);
    const existingIds = await odoo.executeKw(
      db,
      odooUid,
      password,
      'kemfai.module.selection.event',
      'search',
      [[]],
      { order: 'id desc', limit: 1 },
    );
    assertNumericIds(existingIds);
    const eventIdBefore = existingIds[0] ?? 0;

    const calls = [
      httpPut(ownerToken, ['module.accounting']),
      httpPut(ownerToken, []),
      httpPut(ownerToken, ['module.accounting']),
    ];
    const responses = await Promise.all(calls);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    responses.forEach((response) =>
      contract.assertResponse('/modules/selection', 'put', response.status, response.body),
    );
    expect(responses[0].body).toEqual({ featureKeys: ['module.accounting'] });
    expect(responses[1].body).toEqual({ featureKeys: [] });
    expect(responses[2].body).toEqual({ featureKeys: ['module.accounting'] });

    const events = await odoo.executeKw(
      db,
      odooUid,
      password,
      'kemfai.module.selection.event',
      'search_read',
      [[['id', '>', eventIdBefore]]],
      {
        fields: [
          'id',
          'operation_uuid',
          'requested_json',
          'result_json',
          'added_json',
          'removed_json',
          'audited',
        ],
        order: 'id asc',
      },
    );
    assertSelectionEvents(events);
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.operation_uuid)).size).toBe(3);

    let previous: string[] = [];
    const expectedAudits = new Map<string, { added: string[]; removed: string[] }>();
    for (const event of events) {
      const requested = parseFeatureKeys(event.requested_json, 'requested_json');
      const result = parseFeatureKeys(event.result_json, 'result_json');
      const added = parseFeatureKeys(event.added_json, 'added_json');
      const removed = parseFeatureKeys(event.removed_json, 'removed_json');
      const expectedAdded = result.filter((key) => !previous.includes(key));
      const expectedRemoved = previous.filter((key) => !result.includes(key));
      expect(requested).toEqual(result);
      expect(added).toEqual(expectedAdded);
      expect(removed).toEqual(expectedRemoved);
      expect(event.audited).toBe(true);
      expectedAudits.set(`modules.selection.changed:${event.operation_uuid}`, {
        added,
        removed,
      });
      previous = result;
    }

    expect(
      await odoo.executeKw(
        db,
        odooUid,
        password,
        'kemfai.module.selection',
        'kemfai_get_selection',
        [],
      ),
    ).toEqual(previous);
    const auditKeys = [...expectedAudits.keys()];
    const audits: Array<{ dedupe_key: string; payload: unknown }> = await controlDataSource.query(
      `SELECT dedupe_key,payload FROM audit_event
       WHERE tenant_id=$1 AND action='modules.selection.changed' AND dedupe_key = ANY($2::text[])
       ORDER BY dedupe_key`,
      [tenantId, auditKeys],
    );
    expect(audits).toHaveLength(3);
    expect(new Set(audits.map((audit) => audit.dedupe_key)).size).toBe(3);
    for (const audit of audits) {
      expect(audit.payload).toEqual(expectedAudits.get(audit.dedupe_key));
    }
    expect(
      await odoo.executeKw(
        db,
        odooUid,
        password,
        'kemfai.module.selection',
        'kemfai_get_pending_selection_event',
        [],
      ),
    ).toBe(false);
  });
});
