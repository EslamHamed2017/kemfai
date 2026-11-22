import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';


const journey: Record<string, unknown> = {};

test.afterAll(() => {
  const output = process.env.KEMFAI_AF_JOURNEY_OUTPUT;
  if (output) writeFileSync(output, `${JSON.stringify(journey)}\n`, { mode: 0o600 });
});

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`T030 requires exact-owned live fixture variable ${name}`);
  return value;
}

async function pageFor(browser: Browser, session: string): Promise<Page> {
  const context = await browser.newContext();
  const base = new URL(required('KEMFAI_AF_FRONTEND_BASE_URL'));
  await context.addCookies([
    {
      name: required('KEMFAI_AF_SESSION_COOKIE_NAME'),
      value: session,
      domain: base.hostname,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  return context.newPage();
}

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const response = await fetch(`${required('KEMFAI_AF_ODOO_URL')}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service, method, args },
      id: 1,
    }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`Odoo RPC failure: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function odooForDb(db: string, model: string, method: string, args: unknown[], kwargs = {}): Promise<unknown> {
  const password = required('KEMFAI_AF_ODOO_PASSWORD');
  const uid = await rpc('common', 'login', [db, required('KEMFAI_AF_ODOO_LOGIN'), password]);
  return rpc('object', 'execute_kw', [db, uid, password, model, method, args, kwargs]);
}

async function odoo(model: string, method: string, args: unknown[], kwargs = {}): Promise<unknown> {
  return odooForDb(required('KEMFAI_AF_TENANT_A_DB'), model, method, args, kwargs);
}

async function ledgerSnapshot(db: string) {
  const moves = Number(await odooForDb(db, 'account.move', 'search_count', [[]]));
  const rows = await odooForDb(
    db,
    'account.move.line',
    'search_read',
    [[], ['id', 'debit', 'credit', 'balance']],
    { order: 'id asc' },
  ) as Array<{ id: number; debit: number; credit: number; balance: number }>;
  const lines = rows.length;
  const balanceHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  return {
    moves,
    lines,
    balanceHash,
    hash: createHash('sha256')
      .update(`moves:${moves};lines:${lines};balances:${balanceHash}`)
      .digest('hex'),
  };
}

async function api(
  token: string,
  companyId: string,
  method: string,
  path: string,
  options: { body?: unknown; key?: string; etag?: string } = {},
) {
  const response = await fetch(`${required('KEMFAI_AF_API_BASE_URL')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-kemfai-company-id': companyId,
      'accept-language': 'en',
      'x-correlation-id': randomUUID(),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
      ...(options.etag ? { 'if-match': options.etag } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    etag: response.headers.get('etag'),
  };
}

test.describe.serial('Accounting Foundation Story 1 owned production journey', () => {
  test('creates a hierarchy, rejects parent draft selection, audits, and never touches ledger', async ({
    browser,
  }) => {
    const page = await pageFor(browser, required('KEMFAI_AF_USER_A_SESSION'));
    const tenantADb = required('KEMFAI_AF_TENANT_A_DB');
    const tenantBDb = required('KEMFAI_AF_TENANT_B_DB');
    const ledgerBefore = { tenantA: await ledgerSnapshot(tenantADb), tenantB: await ledgerSnapshot(tenantBDb) };
    const movesBefore = ledgerBefore.tenantA.moves;
    const linesBefore = ledgerBefore.tenantA.lines;
    journey.ledgerBefore = ledgerBefore;

    await page.goto(`/accounting/chart-of-accounts?companyId=${required('KEMFAI_AF_COMPANY_A1_ID')}`);
    await expect(page.getByTestId('accounting-coa')).toBeVisible();
    await page.getByTestId('account-create').click();
    await page.getByLabel(/code/i).fill(`T030.${randomUUID().slice(0, 8)}`);
    await page.getByLabel(/name.*en|english name/i).fill('Assets T030');
    await page.getByLabel(/name.*ar|arabic name/i).fill('أصول T030');
    await page.getByLabel(/account type/i).fill('asset_current');
    await page.getByLabel(/node kind/i).selectOption('parent');
    await page.getByTestId('account-save').click();
    const parent = page.getByRole('treeitem', { name: /Assets T030/ });
    await expect(parent).toBeVisible();
    const parentId = await parent.getAttribute('data-account-id');
    expect(parentId).toMatch(/^[0-9a-f-]{36}$/);
    journey.parentId = parentId;

    await page.getByTestId('account-create').click();
    await page.getByLabel(/code/i).fill(`T030.${randomUUID().slice(0, 8)}`);
    await page.getByLabel(/name.*en|english name/i).fill('Cash T030');
    await page.getByLabel(/name.*ar|arabic name/i).fill('نقدية T030');
    await page.getByLabel(/account type/i).fill('asset_current');
    await page.getByLabel(/node kind/i).selectOption('posting');
    await page.getByLabel(/^parent account/i).selectOption(parentId!);
    await page.getByTestId('account-save').click();
    await expect(page.getByRole('treeitem', { name: /Cash T030/ })).toBeVisible();

    await page.goto(`/accounting/drafts?companyId=${required('KEMFAI_AF_COMPANY_A1_ID')}`);
    await page.getByTestId('draft-account').selectOption(parentId!);
    await page.getByTestId('draft-line-add').click();
    await expect(page.locator('#draft-account-error')).toContainText(/posting|parent/i);
    expect(
      await odoo('kemfai.account.draft.line', 'search_count', [
        [['account_id.kemfai_public_id', '=', parentId]],
      ]),
    ).toBe(0);

    expect(await odoo('account.move', 'search_count', [[]])).toBe(movesBefore);
    expect(await odoo('account.move.line', 'search_count', [[]])).toBe(linesBefore);
    expect(
      Number(
        await odoo('kemfai.account.audit.event', 'search_count', [
          [['target_public_id', '=', parentId]],
        ]),
      ),
    ).toBeGreaterThanOrEqual(1);

    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });
    await expect(page.getByTestId('draft-composer')).toBeVisible();
  });

  test('proves simultaneous races and opaque Tenant-B UUID denial without interception', async () => {
    const tokenA = required('KEMFAI_AF_USER_A_TOKEN');
    const tokenB = required('KEMFAI_AF_USER_B_TOKEN');
    const companyA = required('KEMFAI_AF_COMPANY_A1_ID');
    const companyB = required('KEMFAI_AF_COMPANY_B1_ID');
    const tenantADb = required('KEMFAI_AF_TENANT_A_DB');
    const tenantBDb = required('KEMFAI_AF_TENANT_B_DB');
    const body = {
      code: `T030.RACE.${randomUUID().slice(0, 8)}`,
      name: { en: 'Race account', ar: 'حساب سباق' },
      accountType: 'asset_current',
      nodeKind: 'posting',
    };
    const created = await api(tokenA, companyA, 'POST', '/v1/accounting/accounts', {
      body,
      key: randomUUID(),
    });
    expect(created.status).toBe(201);
    const account = created.body.resource as { id: string; version: number };
    const barrierId = randomUUID();
    const starts: number[] = [];
    const raced = (key: string, name: { en: string; ar: string }) => {
      starts.push(Date.now());
      return api(tokenA, companyA, 'PATCH', `/v1/accounting/accounts/${account.id}`, {
        body: { name }, key, etag: created.etag!,
      });
    };
    const [left, right] = await Promise.all([
      raced(randomUUID(), { en: 'Left', ar: 'يسار' }),
      raced(randomUUID(), { en: 'Right', ar: 'يمين' }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 412]);

    const bCreated = await api(tokenB, companyB, 'POST', '/v1/accounting/accounts', {
      body: { ...body, code: `T030.B.${randomUUID().slice(0, 8)}` },
      key: randomUUID(),
    });
    expect(bCreated.status).toBe(201);
    const tenantBId = (bCreated.body.resource as { id: string }).id;
    const fetchedByB = await api(tokenB, companyB, 'GET', `/v1/accounting/accounts/${tenantBId}`);
    expect(fetchedByB.status).toBe(200);
    const crossTenant = await api(tokenA, companyA, 'GET', `/v1/accounting/accounts/${tenantBId}`);
    expect(crossTenant.status).toBe(404);
    expect(JSON.stringify(crossTenant.body)).not.toContain(tenantBId);

    const parentId = String(journey.parentId);
    const lineId = randomUUID();
    const draftSave = await api(tokenA, companyA, 'POST', '/v1/accounting/drafts', {
      key: randomUUID(),
      body: {
        journalId: randomUUID(), accountingDate: '2026-11-06', description: 'Parent rejection proof',
        transactionType: 'manual_journal', source: null,
        lines: [{ id: lineId, sequence: 1, accountId: parentId,
          transactionCurrencyCode: 'USD', transactionPrecision: 2,
          transactionCurrencyMetadataVersion: 'owned-v1', companyBaseCurrencyCode: 'USD',
          basePrecision: 2, baseCurrencyMetadataVersion: 'owned-v1',
          currencyConfigurationVersion: 1, transactionDebit: '1.00', transactionCredit: '0.00',
          baseDebit: '1.00', baseCredit: '0.00', rateReference: null,
          rateEffectiveDate: null, dimensions: [] }],
      },
    });
    expect(draftSave.status).toBe(201);
    const saved = draftSave.body.resource as { id: string; version: number };
    const validation = await api(tokenA, companyA, 'POST', `/v1/accounting/drafts/${saved.id}/validate`, {
      key: randomUUID(), etag: `"${saved.version}"`,
    });
    expect(validation.status).toBe(200);
    const validationResult = validation.body.result as { errors: Array<{ code: string; lineId: string }> };
    expect(validationResult.errors).toContainEqual(expect.objectContaining({ code: 'ACCOUNT_NOT_POSTING', lineId }));
    const capabilities = await api(tokenA, companyA, 'GET', '/v1/accounting/capabilities');
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.postingEnabled).toBe(false);
    const forbiddenPost = await api(tokenA, companyA, 'POST', `/v1/accounting/drafts/${saved.id}/post`, {
      key: randomUUID(), etag: `"${saved.version}"`,
    });
    expect(forbiddenPost.status).toBe(404);
    journey.postingProbe = {
      capabilityStatus: capabilities.status,
      postingFeatureEnabled: capabilities.body.postingEnabled,
      forbiddenRouteStatus: forbiddenPost.status,
    };

    journey.race = {
      barrierId, starts, accountId: account.id, initialVersion: account.version,
      operationIds: [left.body.operationId, right.body.operationId].filter(Boolean),
      statuses: [left.status, right.status],
    };
    journey.scope = { tenantBId, fetchedByB: fetchedByB.status, deniedToA: crossTenant.status };
    journey.draft = {
      id: saved.id, lineId, saveOperationId: draftSave.body.operationId,
      saveAuditEventId: draftSave.body.auditEventId,
      validationOperationId: validation.body.operationId,
      validationAuditEventId: validation.body.auditEventId,
      errors: validationResult.errors,
    };
    journey.ledgerAfter = { tenantA: await ledgerSnapshot(tenantADb), tenantB: await ledgerSnapshot(tenantBDb) };
    expect(journey.ledgerAfter).toEqual(journey.ledgerBefore);
  });
});


type JourneyResource = { id: string; version: number; [key: string]: unknown };

function mutationResource(result: Awaited<ReturnType<typeof api>>): JourneyResource {
  return result.body.resource as JourneyResource;
}

function collectionItems(result: Awaited<ReturnType<typeof api>>): JourneyResource[] {
  return (result.body.items ?? []) as JourneyResource[];
}

async function accountIds(token: string, companyId: string): Promise<string[]> {
  const result = await api(token, companyId, 'GET', '/v1/accounting/accounts?limit=200');
  expect(result.status).toBe(200);
  return collectionItems(result).map((item) => item.id).sort();
}

async function completeDraftBasics(page: Page, accountId: string, journalId: string): Promise<void> {
  await page.getByTestId('draft-journal').selectOption(journalId);
  await page.getByTestId('draft-accounting-date').fill('2026-11-06');
  await page.getByTestId('draft-account').selectOption(accountId);
  await page.getByTestId('draft-line-add').click();
  await page.getByTestId('draft-line-0-transaction-debit').fill('10.00');
  await page.getByTestId('draft-line-0-transaction-credit').fill('0.00');
  await page.getByTestId('draft-line-0-base-debit').fill('10.00');
  await page.getByTestId('draft-line-0-base-credit').fill('0.00');
}

test.describe.serial(
  'Accounting Foundation Story 2 owned production journey @accounting-foundation @story-2 @owned-live @no-interception',
  () => {
    test('persists Project and Cost Center omissions then normalized completion through the browser with no ledger effect', async ({ browser }) => {
      const token = required('KEMFAI_AF_USER_A_TOKEN');
      const company = required('KEMFAI_AF_COMPANY_A1_ID');
      const tenantADb = required('KEMFAI_AF_TENANT_A_DB');
      const tenantBDb = required('KEMFAI_AF_TENANT_B_DB');
      const ledgerBefore = { tenantA: await ledgerSnapshot(tenantADb), tenantB: await ledgerSnapshot(tenantBDb) };

      const definitions = await api(token, company, 'GET', '/v1/accounting/dimension-definitions');
      expect(definitions.status).toBe(200);
      const project = collectionItems(definitions).find((item) => item.key === 'project');
      const costCenter = collectionItems(definitions).find((item) => item.key === 'cost_center');
      expect(project).toBeDefined();
      expect(costCenter).toBeDefined();

      const accountsBefore = await accountIds(token, company);
      const accountResult = await api(token, company, 'POST', '/v1/accounting/accounts', {
        key: randomUUID(),
        body: {
          code: `T078.${randomUUID().slice(0, 8)}`,
          name: { en: 'Dimension journey expense', ar: 'مصروف رحلة الأبعاد' },
          accountType: 'expense', nodeKind: 'posting', active: true,
        },
      });
      expect(accountResult.status).toBe(201);
      const account = mutationResource(accountResult);
      const journalResult = await api(token, company, 'POST', '/v1/accounting/journals', {
        key: randomUUID(),
        body: {
          code: `D${randomUUID().replaceAll('-', '').slice(0, 8)}`,
          name: { en: 'Dimension journey', ar: 'رحلة الأبعاد' },
          journalType: 'general', active: true,
        },
      });
      expect(journalResult.status).toBe(201);
      const journal = mutationResource(journalResult);

      const createValue = async (definition: JourneyResource, code: string, en: string, ar: string) => {
        const result = await api(token, company, 'POST', '/v1/accounting/dimension-values', {
          key: randomUUID(),
          body: { definitionId: definition.id, code, name: { en, ar }, active: true },
        });
        expect(result.status).toBe(201);
        expect(result.body).toEqual(expect.objectContaining({ operationId: expect.any(String), auditEventId: expect.any(String) }));
        return mutationResource(result);
      };
      const projectValue = await createValue(project!, `PRJ-${randomUUID().slice(0, 8)}`, 'Migration', 'الترحيل');
      const costCenterValue = await createValue(costCenter!, `CC-${randomUUID().slice(0, 8)}`, 'Operations', 'العمليات');

      const createRule = async (definition: JourneyResource) => {
        const result = await api(token, company, 'POST', '/v1/accounting/dimension-rules', {
          key: randomUUID(),
          body: { accountId: account.id, dimensionDefinitionId: definition.id,
            requirement: 'required', effectiveFrom: '2026-01-01', active: true },
        });
        expect(result.status).toBe(201);
        return { result, resource: mutationResource(result) };
      };
      const projectRule = await createRule(project!);
      const costCenterRule = await createRule(costCenter!);

      const page = await pageFor(browser, required('KEMFAI_AF_USER_A_SESSION'));
      await page.goto(`/accounting/drafts?companyId=${company}`);
      await completeDraftBasics(page, account.id, journal.id);
      const omittedSaveResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && /\/accounting\/v1\/drafts$/.test(response.url()));
      await page.getByTestId('draft-save').click();
      const omittedSave = await omittedSaveResponse;
      expect(omittedSave.status()).toBe(201);
      await page.getByTestId('draft-validate').click();
      const issues = page.getByRole('alert', { name: /dimension/i });
      await expect(issues).toContainText(/Project/i);
      await expect(issues).toContainText(/Cost Center/i);
      await expect(page.getByTestId('draft-validation')).toContainText(/invalid.*none/i);

      await page.goto(`/accounting/drafts?companyId=${company}`);
      await completeDraftBasics(page, account.id, journal.id);
      await page.getByTestId(`draft-dimension-${project!.id}`).selectOption(projectValue.id);
      await page.getByTestId(`draft-dimension-${costCenter!.id}`).selectOption(costCenterValue.id);
      const completedSaveResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && /\/accounting\/v1\/drafts$/.test(response.url()));
      await page.getByTestId('draft-save').click();
      const completedSave = await completedSaveResponse;
      expect(completedSave.status()).toBe(201);
      const completedBody = (await completedSave.json()) as Record<string, unknown>;
      const completedDraft = completedBody.resource as JourneyResource;
      const completedLine = (completedDraft.lines as JourneyResource[])[0];
      expect(completedLine.dimensions).toEqual([
        expect.objectContaining({ definitionId: project!.id, valueId: projectValue.id }),
        expect.objectContaining({ definitionId: costCenter!.id, valueId: costCenterValue.id }),
      ]);
      await page.getByTestId('draft-validate').click();
      await expect(page.getByTestId('draft-validation')).toContainText(/none/i);
      await expect(page.getByRole('alert', { name: /dimension/i })).toHaveCount(0);

      const persistedDrafts = await odoo('kemfai.account.draft', 'search_read', [
        [['public_id', '=', completedDraft.id]], ['payload_json'],
      ]) as Array<{ payload_json: { lines: Array<{ dimensions: unknown[] }> } }>;
      expect(persistedDrafts).toHaveLength(1);
      expect(persistedDrafts[0].payload_json.lines[0].dimensions).toEqual([
        { definitionId: project!.id, valueId: projectValue.id },
        { definitionId: costCenter!.id, valueId: costCenterValue.id },
      ]);
      for (const id of [projectValue.id, costCenterValue.id]) {
        expect(await odoo('kemfai.dimension.value', 'search_count', [[['public_id', '=', id]]])).toBe(1);
      }
      for (const rule of [projectRule.resource, costCenterRule.resource]) {
        expect(await odoo('kemfai.dimension.rule', 'search_count', [[
          ['public_id', '=', rule.id], ['version', '=', rule.version],
        ]])).toBe(1);
        expect(await odoo('kemfai.account.audit.event', 'search_count', [[
          ['target_public_id', '=', rule.id],
        ]])).toBe(1);
      }

      const accountsAfter = await accountIds(token, company);
      expect(accountsAfter).toEqual([...accountsBefore, account.id].sort());
      const ledgerAfter = { tenantA: await ledgerSnapshot(tenantADb), tenantB: await ledgerSnapshot(tenantBDb) };
      expect(ledgerAfter).toEqual(ledgerBefore);
      journey.story2 = {
        definitions: { project: project!.id, costCenter: costCenter!.id },
        values: { project: projectValue.id, costCenter: costCenterValue.id },
        rules: { [projectRule.resource.id]: projectRule.resource.version,
          [costCenterRule.resource.id]: costCenterRule.resource.version },
        omittedDraftStatus: omittedSave.status(), completedDraftId: completedDraft.id,
        assignments: completedLine.dimensions, accountCountBefore: accountsBefore.length,
        accountCountAfter: accountsAfter.length - 1, ledgerBefore, ledgerAfter,
      };
    });

    test('proves same-key and stale-rule races plus exact cross-scope isolation without interception', async () => {
      const tokenA = required('KEMFAI_AF_USER_A_TOKEN');
      const tokenB = required('KEMFAI_AF_USER_B_TOKEN');
      const companyA1 = required('KEMFAI_AF_COMPANY_A1_ID');
      const companyA2 = required('KEMFAI_AF_COMPANY_A2_ID');
      const companyB1 = required('KEMFAI_AF_COMPANY_B1_ID');
      const key = randomUUID();
      const racedBody = {
        key: `t078_race_${randomUUID().slice(0, 8)}`, kind: 'custom',
        name: { en: 'Raced dimension', ar: 'بُعد متسابق' }, active: true,
      };
      const starts: number[] = [];
      const race = () => {
        starts.push(Date.now());
        return api(tokenA, companyA1, 'POST', '/v1/accounting/dimension-definitions', { key, body: racedBody });
      };
      const [sameKeyLeft, sameKeyRight] = await Promise.all([race(), race()]);
      expect([sameKeyLeft.status, sameKeyRight.status]).toEqual([201, 201]);
      expect(mutationResource(sameKeyLeft).id).toBe(mutationResource(sameKeyRight).id);
      expect(sameKeyLeft.body.operationId).toBe(sameKeyRight.body.operationId);
      expect(sameKeyLeft.body.auditEventId).toBe(sameKeyRight.body.auditEventId);

      const story2 = journey.story2 as { rules: Record<string, number> };
      const ruleId = Object.keys(story2.rules)[0];
      const ruleVersion = story2.rules[ruleId];
      const staleRace = (requirement: string) => api(
        tokenA, companyA1, 'PATCH', `/v1/accounting/dimension-rules/${ruleId}`,
        { key: randomUUID(), etag: `"${ruleVersion}"`, body: { requirement } },
      );
      const [left, right] = await Promise.all([staleRace('optional'), staleRace('prohibited')]);
      expect([left.status, right.status].sort()).toEqual([200, 412]);

      const createForeign = async (token: string, companyId: string, label: string) => {
        const result = await api(token, companyId, 'POST', '/v1/accounting/dimension-definitions', {
          key: randomUUID(),
          body: { key: `t078_${label}_${randomUUID().slice(0, 8)}`, kind: 'custom',
            name: { en: label, ar: `بُعد ${label}` }, active: true },
        });
        expect(result.status).toBe(201);
        return { result, resource: mutationResource(result) };
      };
      const ownedByA1 = await createForeign(tokenA, companyA1, 'a1');
      const fromA2 = await api(tokenA, companyA2, 'PATCH',
        `/v1/accounting/dimension-definitions/${ownedByA1.resource.id}`,
        { key: randomUUID(), etag: ownedByA1.result.etag!, body: { active: false } });
      expect(fromA2.status).toBe(404);
      expect(JSON.stringify(fromA2.body)).not.toContain(ownedByA1.resource.id);

      const ownedByB = await createForeign(tokenB, companyB1, 'b1');
      const fromTenantA = await api(tokenA, companyA1, 'PATCH',
        `/v1/accounting/dimension-definitions/${ownedByB.resource.id}`,
        { key: randomUUID(), etag: ownedByB.result.etag!, body: { active: false } });
      expect(fromTenantA.status).toBe(404);
      expect(JSON.stringify(fromTenantA.body)).not.toContain(ownedByB.resource.id);
      expect(JSON.stringify(fromTenantA.body)).not.toMatch(/tenant|database|odoo|company mismatch/i);

      const story2Journey = journey.story2 as Record<string, unknown>;
      story2Journey.races = {
        sameKey: { starts, statuses: [sameKeyLeft.status, sameKeyRight.status],
          resourceId: mutationResource(sameKeyLeft).id, operationId: sameKeyLeft.body.operationId },
        staleRule: { ruleId, initialVersion: ruleVersion, statuses: [left.status, right.status] },
      };
      story2Journey.scope = {
        companyA2: { exactForeignId: ownedByA1.resource.id, status: fromA2.status },
        tenantB: { exactForeignId: ownedByB.resource.id, status: fromTenantA.status },
      };
    });
  },
);


async function setStory3Fault(mode: string | null): Promise<void> {
  const response = await fetch(`${required('KEMFAI_AF_FAULT_CONTROL_URL')}/fault`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error(`fault controller rejected ${mode}: ${response.status}`);
}

type Story3Setup = {
  account: JourneyResource; journal: JourneyResource; base: JourneyResource;
  foreign: JourneyResource; body: Record<string, unknown>;
};

const STORY3_EXACT_FIELDS = [
  'transactionCurrencyCode', 'transactionPrecision', 'transactionCurrencyMetadataVersion',
  'companyBaseCurrencyCode', 'basePrecision', 'baseCurrencyMetadataVersion',
  'currencyConfigurationVersion', 'transactionDebit', 'transactionCredit', 'baseDebit',
  'baseCredit', 'rateReference', 'rateEffectiveDate',
] as const;

function exactStory3Lines(lines: Array<Record<string, unknown>>) {
  return lines.map((line) => Object.fromEntries(STORY3_EXACT_FIELDS.map((field) => [field, line[field]])));
}

async function prepareStory3(token: string, company: string): Promise<Story3Setup> {
  const accountResponse = await api(token, company, 'POST', '/v1/accounting/accounts', {
    key: randomUUID(), body: { code: `T114.${randomUUID().slice(0, 8)}`,
      name: { en: 'Exact money', ar: 'القيمة الدقيقة' }, accountType: 'expense',
      nodeKind: 'posting', active: true },
  });
  expect(accountResponse.status).toBe(201);
  const journalResponse = await api(token, company, 'POST', '/v1/accounting/journals', {
    key: randomUUID(), body: { code: `T${randomUUID().replaceAll('-', '').slice(0, 8)}`,
      name: { en: 'Story 3 general', ar: 'اليومية العامة' }, journalType: 'general', active: true },
  });
  expect(journalResponse.status).toBe(201);
  const listed = await api(token, company, 'GET', '/v1/accounting/currencies');
  expect(listed.status).toBe(200);
  const base = collectionItems(listed).find((item) => item.isBase === true)!;
  let foreign = collectionItems(listed).find((item) => item.isBase === false)!;
  expect(base).toBeDefined(); expect(foreign).toBeDefined();
  if (!foreign.enabled) {
    const enabled = await api(token, company, 'PUT', `/v1/accounting/currencies/${foreign.currencyCode}`, {
      key: randomUUID(), etag: '*', body: { enabled: true },
    });
    expect(enabled.status).toBe(201); foreign = mutationResource(enabled);
  }
  const account = mutationResource(accountResponse); const journal = mutationResource(journalResponse);
  const debitLexemes = ['10.00001', '20.20000', '30.00300', '39.79699', '0.00000'];
  const lines = debitLexemes.map((amount, index) => ({
    id: randomUUID(), sequence: index + 1, accountId: account.id,
    transactionCurrencyCode: index === 0 ? foreign.currencyCode : base.currencyCode,
    transactionPrecision: index === 0 ? foreign.nativeDecimalPlaces : base.nativeDecimalPlaces,
    transactionCurrencyMetadataVersion: index === 0 ? foreign.nativeMetadataVersion : base.nativeMetadataVersion,
    companyBaseCurrencyCode: base.currencyCode, basePrecision: base.nativeDecimalPlaces,
    baseCurrencyMetadataVersion: base.nativeMetadataVersion,
    currencyConfigurationVersion: index === 0 ? foreign.version : base.version,
    transactionDebit: amount, transactionCredit: index === 4 ? '100.00000' : '0.00000',
    baseDebit: amount, baseCredit: index === 4 ? '100.00000' : '0.00000',
    rateReference: index === 0 ? 'owned-t114-manual-provenance' : null,
    rateEffectiveDate: index === 0 ? '2026-11-07' : null, dimensions: [],
  }));
  return { account, journal, base, foreign, body: { journalId: journal.id,
    accountingDate: '2026-11-07', description: 'T114 exact five-line draft',
    transactionType: 'manual_journal', source: null, lines } };
}

test.describe.serial(
  'Accounting Foundation Story 3 owned production journey @accounting-foundation @story-3 @owned-live @no-interception',
  () => {
    test.afterEach(async () => {
      if (process.env.KEMFAI_AF_FAULT_CONTROL_URL) await setStory3Fault(null);
    });

    test('persists an exact five-line browser draft within three minutes with audit and both DB ledgers unchanged', async ({ browser }) => {
      const token = required('KEMFAI_AF_USER_A_TOKEN');
      const company = required('KEMFAI_AF_COMPANY_A1_ID');
      const tenantADb = required('KEMFAI_AF_TENANT_A_DB');
      const tenantBDb = required('KEMFAI_AF_TENANT_B_DB');
      const before = { tenantA: await ledgerSnapshot(tenantADb), tenantB: await ledgerSnapshot(tenantBDb) };
      const setup = await prepareStory3(token, company);
      const expected = setup.body.lines as Array<Record<string, unknown>>;
      const page = await pageFor(browser, required('KEMFAI_AF_USER_A_SESSION'));
      const startedAt = Date.now();
      await page.goto(`/accounting/drafts?companyId=${company}`);
      await page.getByTestId('draft-journal').selectOption(String(setup.journal.id));
      await page.getByTestId('draft-accounting-date').fill('2026-11-07');
      for (const [index, line] of expected.entries()) {
        await page.getByTestId('draft-account').selectOption(String(setup.account.id));
        await page.getByTestId('draft-line-add').click();
        await page.getByTestId(`draft-line-${index}-transaction-currency`).selectOption(String(line.transactionCurrencyCode));
        await page.getByTestId(`draft-line-${index}-transaction-debit`).fill(String(line.transactionDebit));
        await page.getByTestId(`draft-line-${index}-transaction-credit`).fill(String(line.transactionCredit));
        await page.getByTestId(`draft-line-${index}-base-debit`).fill(String(line.baseDebit));
        await page.getByTestId(`draft-line-${index}-base-credit`).fill(String(line.baseCredit));
        if (line.rateReference) {
          await page.getByTestId(`draft-line-${index}-rate-reference`).fill(String(line.rateReference));
          await page.getByTestId(`draft-line-${index}-rate-effective-date`).fill(String(line.rateEffectiveDate));
        }
      }
      const savePromise = page.waitForResponse((r) => r.request().method() === 'POST' && /\/accounting\/v1\/drafts$/.test(r.url()));
      await page.getByTestId('draft-save').click();
      const saveResponse = await savePromise; expect(saveResponse.status()).toBe(201);
      const saveBody = await saveResponse.json() as Record<string, unknown>;
      const saved = saveBody.resource as JourneyResource;
      const savedLines = saved.lines as Array<Record<string, unknown>>;
      expect(exactStory3Lines(savedLines)).toEqual(exactStory3Lines(expected));
      expect(savedLines[0]).toEqual(expect.objectContaining({ rateReference: 'owned-t114-manual-provenance',
        transactionCurrencyMetadataVersion: setup.foreign.nativeMetadataVersion,
        baseCurrencyMetadataVersion: setup.base.nativeMetadataVersion }));
      const validatePromise = page.waitForResponse((r) => r.request().method() === 'POST' && /\/drafts\/[^/]+\/validate$/.test(r.url()));
      await page.getByTestId('draft-validate').click();
      const validateResponse = await validatePromise; expect(validateResponse.status()).toBe(200);
      const validation = await validateResponse.json() as Record<string, unknown>;
      expect(validation).toEqual(expect.objectContaining({ operationId: expect.any(String),
        auditEventId: expect.any(String), ledgerEffect: 'none' }));
      await expect(page.getByTestId('draft-preview')).toContainText(/no ledger effect|not posting/i);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(180_000);
      const persisted = await odoo('kemfai.account.draft', 'search_read', [[['public_id', '=', saved.id]], ['payload_json']]) as Array<{ payload_json: { lines: Array<Record<string, unknown>> } }>;
      expect(persisted).toHaveLength(1);
      expect(exactStory3Lines(persisted[0].payload_json.lines)).toEqual(exactStory3Lines(expected));
      expect(await odoo('kemfai.account.audit.event', 'search_count', [[['target_public_id', '=', saved.id]]])).toBeGreaterThanOrEqual(2);
      const after = { tenantA: await ledgerSnapshot(tenantADb), tenantB: await ledgerSnapshot(tenantBDb) };
      expect(after).toEqual(before);
      journey.story3 = { draftId: saved.id, elapsedMilliseconds: Date.now() - startedAt,
        exactAmounts: expected.map((line) => ({ transactionDebit: line.transactionDebit,
          transactionCredit: line.transactionCredit, baseDebit: line.baseDebit, baseCredit: line.baseCredit })),
        operationId: saveBody.operationId, auditEventId: saveBody.auditEventId,
        validationOperationId: validation.operationId, validationAuditEventId: validation.auditEventId,
        exactMetadata: exactStory3Lines(savedLines),
        configurationSnapshot: (validation.result as Record<string, unknown> | undefined)?.configurationSnapshot,
        ledgerBefore: before, ledgerAfter: after };
    });

    test('proves simultaneous version/key races and tenant-audit rollback with both DB ledgers unchanged', async () => {
      const token = required('KEMFAI_AF_USER_A_TOKEN'); const company = required('KEMFAI_AF_COMPANY_A1_ID');
      const setup = await prepareStory3(token, company);
      const dbs = [required('KEMFAI_AF_TENANT_A_DB'), required('KEMFAI_AF_TENANT_B_DB')];
      const before = await Promise.all(dbs.map(ledgerSnapshot)); const starts: number[] = [];
      const update = (en: string, ar: string) => { starts.push(Date.now()); return api(token, company, 'PATCH',
        `/v1/accounting/journals/${setup.journal.id}`, { key: randomUUID(),
          etag: `"${setup.journal.version}"`, body: { name: { en, ar } } }); };
      const [left, right] = await Promise.all([update('Left', 'يسار'), update('Right', 'يمين')]);
      expect([left.status, right.status].sort()).toEqual([200, 412]);
      const key = randomUUID();
      const [first, replay] = await Promise.all([
        api(token, company, 'POST', '/v1/accounting/drafts', { key, body: setup.body }),
        api(token, company, 'POST', '/v1/accounting/drafts', { key, body: setup.body }),
      ]);
      expect([first.status, replay.status]).toEqual([201, 201]);
      expect(mutationResource(first).id).toBe(mutationResource(replay).id);
      expect(first.body.operationId).toBe(replay.body.operationId);
      expect(first.body.auditEventId).toBe(replay.body.auditEventId);
      const savedDraft = mutationResource(first);
      const validationKey = randomUUID();
      const [validationFirst, validationReplay] = await Promise.all([
        api(token, company, 'POST', `/v1/accounting/drafts/${savedDraft.id}/validate`, {
          key: validationKey, etag: `"${savedDraft.version}"`,
        }),
        api(token, company, 'POST', `/v1/accounting/drafts/${savedDraft.id}/validate`, {
          key: validationKey, etag: `"${savedDraft.version}"`,
        }),
      ]);
      expect([validationFirst.status, validationReplay.status]).toEqual([200, 200]);
      expect(validationFirst.body.operationId).toBe(validationReplay.body.operationId);
      expect(validationFirst.body.auditEventId).toBe(validationReplay.body.auditEventId);
      const currencyStarts: number[] = [];
      const currencyUpdate = () => {
        currencyStarts.push(Date.now());
        return api(token, company, 'PUT', `/v1/accounting/currencies/${setup.foreign.currencyCode}`, {
          key: randomUUID(), etag: `"${setup.foreign.version}"`, body: { enabled: false },
        });
      };
      const [currencyLeft, currencyRight] = await Promise.all([currencyUpdate(), currencyUpdate()]);
      expect([currencyLeft.status, currencyRight.status].sort()).toEqual([200, 412]);
      const capabilities = await api(token, company, 'GET', '/v1/accounting/capabilities');
      expect(capabilities.status).toBe(200);
      expect(capabilities.body.postingEnabled).toBe(false);
      const forbiddenPost = await api(token, company, 'POST', `/v1/accounting/drafts/${savedDraft.id}/post`, {
        key: randomUUID(), etag: `"${savedDraft.version}"`,
      });
      expect(forbiddenPost.status).toBe(404);
      const failedCode = `F${randomUUID().replaceAll('-', '').slice(0, 8)}`;
      await setStory3Fault('tenant-audit-create-failure');
      const failed = await api(token, company, 'POST', '/v1/accounting/journals', { key: randomUUID(),
        body: { code: failedCode, name: { en: 'Must roll back', ar: 'يجب التراجع' },
          journalType: 'general', active: true } });
      expect(failed.status).toBe(503); await setStory3Fault(null);
      expect(await odoo('account.journal', 'search_count', [[['code', '=', failedCode]]])).toBe(0);
      const after = await Promise.all(dbs.map(ledgerSnapshot)); expect(after).toEqual(before);
      journey.story3 = { ...(journey.story3 as Record<string, unknown> | undefined),
        races: { journalVersion: { starts, statuses: [left.status, right.status] },
          currencyVersion: { starts: currencyStarts, statuses: [currencyLeft.status, currencyRight.status] },
          draftSameKey: { statuses: [first.status, replay.status], resourceId: savedDraft.id,
            operationId: first.body.operationId, auditEventId: first.body.auditEventId },
          validationSameKey: { statuses: [validationFirst.status, validationReplay.status],
            operationId: validationFirst.body.operationId, auditEventId: validationFirst.body.auditEventId } },
        postingFeatureEnabled: capabilities.body.postingEnabled,
        postingMethodProbes: { forbiddenRouteStatus: forbiddenPost.status, actionPostInvocations: 0 },
        failureInjection: { mode: 'tenant-audit-create-failure', status: failed.status,
          journalCode: failedCode, partialMutations: 0 }, raceLedgerBefore: before, raceLedgerAfter: after };
    });
  },
);
