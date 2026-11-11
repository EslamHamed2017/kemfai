import { createHash, randomUUID } from 'node:crypto';

type LiveIdentity = {
  token: string;
  companyId: string;
};

type LiveResponse = {
  status: number;
  body: Record<string, unknown>;
  etag: string | null;
};

type CallOptions = {
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  etag?: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`T076 requires exact-owned live fixture variable ${name}`);
  return value;
}

function identity(tokenName: string, companyName: string): LiveIdentity {
  return { token: required(tokenName), companyId: required(companyName) };
}

type FixtureUser = 'A' | 'B';
type FixtureCompany = 'A1' | 'A2' | 'B1';

function fixtureIdentity(user: FixtureUser, company: FixtureCompany): LiveIdentity {
  const prefix = ['KEMFAI', 'AF'];
  return identity(
    [...prefix, 'USER', user, 'TOKEN'].join('_'),
    [...prefix, 'COMPANY', company, 'ID'].join('_'),
  );
}

async function call(
  who: LiveIdentity,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<LiveResponse> {
  const response = await fetch(`${required('KEMFAI_AF_API_BASE_URL')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${who.token}`,
      'x-kemfai-company-id': who.companyId,
      'accept-language': 'en',
      'x-correlation-id': randomUUID(),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
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

async function setFault(mode: string | null): Promise<void> {
  const response = await fetch(`${required('KEMFAI_AF_FAULT_CONTROL_URL')}/fault`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error(`fault controller rejected mode ${mode}: ${response.status}`);
}

function resource(response: LiveResponse): Record<string, unknown> {
  return response.body.resource as Record<string, unknown>;
}

function expectMutationReceipt(response: LiveResponse): void {
  expect(response.body).toEqual(
    expect.objectContaining({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      auditEventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      replayed: expect.any(Boolean),
    }),
  );
}

function definitionPayload(label: string): Record<string, unknown> {
  const suffix = randomUUID().slice(0, 8);
  return {
    key: `t076_${label.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${suffix}`,
    kind: 'custom',
    name: { en: `Dimension ${label}`, ar: `بُعد ${label}` },
    active: true,
  };
}

function accountPayload(label: string): Record<string, unknown> {
  return {
    code: `T076.${label.replace(/[^A-Za-z0-9]/g, '')}.${randomUUID().slice(0, 8)}`,
    name: { en: `Dimension account ${label}`, ar: `حساب الأبعاد ${label}` },
    accountType: 'asset_current',
    nodeKind: 'posting',
    active: true,
  };
}

async function createAccount(who: LiveIdentity, label: string): Promise<Record<string, unknown>> {
  const response = await call(who, 'POST', '/v1/accounting/accounts', {
    body: accountPayload(label),
    idempotencyKey: randomUUID(),
  });
  expect(response.status).toBe(201);
  return resource(response);
}

async function createDefinition(
  who: LiveIdentity,
  label: string,
): Promise<{ response: LiveResponse; value: Record<string, unknown> }> {
  const response = await call(who, 'POST', '/v1/accounting/dimension-definitions', {
    body: definitionPayload(label),
    idempotencyKey: randomUUID(),
  });
  expect(response.status).toBe(201);
  expect(response.etag).toMatch(/^"[1-9][0-9]*"$/);
  expectMutationReceipt(response);
  return { response, value: resource(response) };
}

function expectOpaqueNotFound(response: LiveResponse, exactId: string): void {
  expect(response.status).toBe(404);
  expect(JSON.stringify(response.body)).not.toContain(exactId);
  expect(JSON.stringify(response.body)).not.toMatch(/tenant|database|odoo|company mismatch/i);
}

async function accountIds(who: LiveIdentity): Promise<string[]> {
  const response = await call(who, 'GET', '/v1/accounting/accounts?limit=200');
  expect(response.status).toBe(200);
  return ((response.body.items ?? []) as Array<Record<string, unknown>>)
    .map((item) => item.id as string)
    .sort();
}

type OdooRpcResponse = {
  result?: unknown;
  error?: { data?: { message?: string }; message?: string };
};

async function odooRpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const response = await fetch(`${required('KEMFAI_AF_ODOO_URL')}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'call',
      params: { service, method, args },
    }),
  });
  const payload = (await response.json()) as OdooRpcResponse;
  if (!response.ok || payload.error) {
    throw new Error(
      `Odoo RPC ${service}.${method} failed: ${payload.error?.data?.message ?? payload.error?.message ?? response.status}`,
    );
  }
  return payload.result;
}

async function odooExecute(
  database: string,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): Promise<unknown> {
  const login = required('KEMFAI_AF_ODOO_LOGIN');
  const password = required('KEMFAI_AF_ODOO_PASSWORD');
  const uid = (await odooRpc('common', 'authenticate', [database, login, password, {}])) as number;
  if (!Number.isInteger(uid) || uid < 1)
    throw new Error(`Odoo authentication failed for ${database}`);
  return odooRpc('object', 'execute_kw', [database, uid, password, model, method, args, kwargs]);
}

async function ledgerDigest(database: string): Promise<string> {
  const [moves, lines] = await Promise.all([
    odooExecute(database, 'account.move', 'search_read', [[]], {
      fields: ['id', 'state', 'date', 'write_date'],
      order: 'id',
    }),
    odooExecute(database, 'account.move.line', 'search_read', [[]], {
      fields: [
        'id',
        'move_id',
        'debit',
        'credit',
        'balance',
        'currency_id',
        'amount_currency',
        'write_date',
      ],
      order: 'id',
    }),
  ]);
  return createHash('sha256').update(JSON.stringify({ moves, lines })).digest('hex');
}

function tenantDatabases(): string[] {
  return [required('KEMFAI_AF_TENANT_A_DB'), required('KEMFAI_AF_TENANT_B_DB')];
}

function journalPayload(label: string): Record<string, unknown> {
  return {
    code: `J${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
    name: { en: `Journal ${label}`, ar: `دفتر ${label}` },
    journalType: 'general',
    active: true,
  };
}

async function createJournal(
  who: LiveIdentity,
  label: string,
): Promise<{ response: LiveResponse; value: Record<string, unknown> }> {
  const response = await call(who, 'POST', '/v1/accounting/journals', {
    body: journalPayload(label),
    idempotencyKey: randomUUID(),
  });
  expect(response.status).toBe(201);
  expect(response.etag).toMatch(/^"[1-9][0-9]*"$/);
  expectMutationReceipt(response);
  return { response, value: resource(response) };
}

describe('Accounting Story 2 real-RPC isolation, audit, and races (T076)', () => {
  const userA1 = () => fixtureIdentity('A', 'A1');
  const userA2 = () => fixtureIdentity('A', 'A2');
  const userB1 = () => fixtureIdentity('B', 'B1');

  afterEach(async () => {
    if (process.env.KEMFAI_AF_FAULT_CONTROL_URL) await setFault(null);
  });

  it('uses two simultaneous HTTP/Odoo transactions with one key for one dimension and one receipt', async () => {
    const who = userA1();
    const key = randomUUID();
    const body = definitionPayload('SAME-KEY');
    const [first, second] = await Promise.all([
      call(who, 'POST', '/v1/accounting/dimension-definitions', {
        body,
        idempotencyKey: key,
      }),
      call(who, 'POST', '/v1/accounting/dimension-definitions', {
        body,
        idempotencyKey: key,
      }),
    ]);

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body).toEqual(second.body);
    expect(resource(first).id).toBe(resource(second).id);
    expect(first.body.operationId).toBe(second.body.operationId);
    expect(first.body.auditEventId).toBe(second.body.auditEventId);
  });

  it('uses simultaneous rule updates with one ETag so one wins and one is stale', async () => {
    const who = userA1();
    const account = await createAccount(who, 'RULE-RACE');
    const definition = await createDefinition(who, 'RULE-RACE');
    const created = await call(who, 'POST', '/v1/accounting/dimension-rules', {
      body: {
        accountId: account.id,
        dimensionDefinitionId: definition.value.id,
        requirement: 'required',
        active: true,
      },
      idempotencyKey: randomUUID(),
    });
    expect(created.status).toBe(201);
    expect(created.etag).toMatch(/^"[1-9][0-9]*"$/);
    const id = resource(created).id as string;

    const [left, right] = await Promise.all([
      call(who, 'PATCH', `/v1/accounting/dimension-rules/${id}`, {
        body: { requirement: 'optional' },
        idempotencyKey: randomUUID(),
        etag: created.etag!,
      }),
      call(who, 'PATCH', `/v1/accounting/dimension-rules/${id}`, {
        body: { requirement: 'prohibited' },
        idempotencyKey: randomUUID(),
        etag: created.etag!,
      }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 412]);
    const winner = left.status === 200 ? left : right;
    expect(resource(winner).version).toBe((resource(created).version as number) + 1);
  });

  it('isolates exact definition UUIDs across A1/A2 and across Tenant A/B', async () => {
    const ownedByA1 = await createDefinition(userA1(), 'A1-OWNER');
    const crossCompany = await call(
      userA2(),
      'PATCH',
      `/v1/accounting/dimension-definitions/${ownedByA1.value.id as string}`,
      {
        body: { active: false },
        idempotencyKey: randomUUID(),
        etag: ownedByA1.response.etag!,
      },
    );
    expectOpaqueNotFound(crossCompany, ownedByA1.value.id as string);

    const ownedByB = await createDefinition(userB1(), 'B1-OWNER-FIRST');
    const tenantBAttempt = await call(
      userA1(),
      'PATCH',
      `/v1/accounting/dimension-definitions/${ownedByB.value.id as string}`,
      {
        body: { active: false },
        idempotencyKey: randomUUID(),
        etag: ownedByB.response.etag!,
      },
    );
    expectOpaqueNotFound(tenantBAttempt, ownedByB.value.id as string);
  });

  it('rolls back the dimension and receipt when authoritative tenant audit creation fails', async () => {
    const who = userA1();
    const body = definitionPayload('AUDIT-ROLLBACK');
    await setFault('tenant-audit-create-failure');
    const failed = await call(who, 'POST', '/v1/accounting/dimension-definitions', {
      body,
      idempotencyKey: randomUUID(),
    });
    expect(failed.status).toBe(503);
    await setFault(null);

    const page = await call(who, 'GET', '/v1/accounting/dimension-definitions');
    expect(page.status).toBe(200);
    expect(
      (page.body.items as Array<Record<string, unknown>>).some((item) => item.key === body.key),
    ).toBe(false);
  });

  it('persists normalized assignments and rule versions with receipts and no account or ledger change', async () => {
    const who = userA1();
    const accountsBefore = await accountIds(who);
    const account = await createAccount(who, 'DRAFT');
    const definition = await createDefinition(who, 'PROJECT');
    const value = await call(who, 'POST', '/v1/accounting/dimension-values', {
      body: {
        definitionId: definition.value.id,
        code: `P-${randomUUID().slice(0, 8)}`,
        name: { en: 'Project T076', ar: 'مشروع T076' },
        active: true,
      },
      idempotencyKey: randomUUID(),
    });
    expect(value.status).toBe(201);
    expectMutationReceipt(value);
    const rule = await call(who, 'POST', '/v1/accounting/dimension-rules', {
      body: {
        accountId: account.id,
        dimensionDefinitionId: definition.value.id,
        requirement: 'required',
        effectiveFrom: '2026-11-06',
        active: true,
      },
      idempotencyKey: randomUUID(),
    });
    expect(rule.status).toBe(201);
    expectMutationReceipt(rule);

    const draft = await call(who, 'POST', '/v1/accounting/drafts', {
      body: {
        journalId: randomUUID(),
        accountingDate: '2026-11-06',
        description: 'T076 normalized dimension assignment',
        transactionType: 'manual_journal',
        lines: [
          {
            id: randomUUID(),
            sequence: 1,
            accountId: account.id,
            transactionCurrencyCode: 'AED',
            transactionPrecision: 2,
            transactionCurrencyMetadataVersion: 'native-aed-v1',
            companyBaseCurrencyCode: 'AED',
            basePrecision: 2,
            baseCurrencyMetadataVersion: 'native-aed-v1',
            currencyConfigurationVersion: 1,
            transactionDebit: '10.00',
            transactionCredit: '0.00',
            baseDebit: '10.00',
            baseCredit: '0.00',
            rateReference: null,
            rateEffectiveDate: null,
            dimensions: [{ definitionId: definition.value.id, valueId: resource(value).id }],
          },
        ],
      },
      idempotencyKey: randomUUID(),
    });
    expect(draft.status).toBe(201);
    expect(draft.body.ledgerEffect).toBe('none');
    expectMutationReceipt(draft);
    const saved = resource(draft);
    expect((saved.lines as Array<Record<string, unknown>>)[0].dimensions as unknown[]).toEqual([
      expect.objectContaining({
        definitionId: definition.value.id,
        valueId: resource(value).id,
      }),
    ]);

    const validated = await call(
      who,
      'POST',
      `/v1/accounting/drafts/${saved.id as string}/validate`,
      { idempotencyKey: randomUUID(), etag: draft.etag! },
    );
    expect(validated.status).toBe(200);
    expect(validated.body.ledgerEffect).toBe('none');
    expectMutationReceipt(validated);
    expect(
      (
        (validated.body.result as Record<string, unknown>).configurationSnapshot as Record<
          string,
          unknown
        >
      ).dimensionRules,
    ).toEqual(expect.objectContaining({ [resource(rule).id as string]: resource(rule).version }));

    const accountsAfter = await accountIds(who);
    expect(accountsAfter).toEqual([...accountsBefore, account.id as string].sort());
  });
});

describe('Accounting Story 3 exact-money real-RPC races and no-ledger proof (T111)', () => {
  const userA1 = () => fixtureIdentity('A', 'A1');

  afterEach(async () => {
    if (process.env.KEMFAI_AF_FAULT_CONTROL_URL) await setFault(null);
  });

  it('runs simultaneous journal version writes and recovers one audit-failed mutation exactly once', async () => {
    const who = userA1();
    const databases = tenantDatabases();
    const before = await Promise.all(databases.map(ledgerDigest));
    const created = await createJournal(who, 'VERSION-RACE');
    const id = created.value.id as string;
    const [left, right] = await Promise.all([
      call(who, 'PATCH', `/v1/accounting/journals/${id}`, {
        body: { name: { en: 'Left winner', ar: 'الفائز الأيسر' } },
        idempotencyKey: randomUUID(),
        etag: created.response.etag!,
      }),
      call(who, 'PATCH', `/v1/accounting/journals/${id}`, {
        body: { name: { en: 'Right winner', ar: 'الفائز الأيمن' } },
        idempotencyKey: randomUUID(),
        etag: created.response.etag!,
      }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 412]);

    const sameKey = randomUUID();
    const sameBody = journalPayload('SAME-KEY-RACE');
    const [firstReplay, secondReplay] = await Promise.all([
      call(who, 'POST', '/v1/accounting/journals', {
        body: sameBody,
        idempotencyKey: sameKey,
      }),
      call(who, 'POST', '/v1/accounting/journals', {
        body: sameBody,
        idempotencyKey: sameKey,
      }),
    ]);
    expect([firstReplay.status, secondReplay.status]).toEqual([201, 201]);
    expect(resource(firstReplay)).toEqual(resource(secondReplay));
    expect(firstReplay.body.operationId).toBe(secondReplay.body.operationId);
    expect(firstReplay.body.auditEventId).toBe(secondReplay.body.auditEventId);

    const recoveryKey = randomUUID();
    const recoveryBody = journalPayload('RECOVERY');
    await setFault('tenant-audit-create-failure');
    const withheld = await call(who, 'POST', '/v1/accounting/journals', {
      body: recoveryBody,
      idempotencyKey: recoveryKey,
    });
    expect(withheld.status).toBe(503);
    await setFault(null);
    const recovered = await call(who, 'POST', '/v1/accounting/journals', {
      body: recoveryBody,
      idempotencyKey: recoveryKey,
    });
    expect(recovered.status).toBe(201);
    expectMutationReceipt(recovered);
    expect(recovered.body.replayed).toBe(false);
    const after = await Promise.all(databases.map(ledgerDigest));
    expect(after).toEqual(before);
  });

  it('runs simultaneous currency ETag writes without allowing native metadata changes', async () => {
    const who = userA1();
    const databases = tenantDatabases();
    const before = await Promise.all(databases.map(ledgerDigest));
    const page = await call(who, 'GET', '/v1/accounting/currencies');
    expect(page.status).toBe(200);
    const base = (page.body.items as Array<Record<string, unknown>>).find(
      (item) => item.isBase === true,
    );
    expect(base).toEqual(
      expect.objectContaining({
        currencyCode: expect.stringMatching(/^[A-Z]{3}$/),
        nativeDecimalPlaces: expect.any(Number),
        nativeMetadataVersion: expect.any(String),
      }),
    );
    const code = base!.currencyCode as string;
    const metadata = {
      currencyCode: base!.currencyCode,
      nativeDecimalPlaces: base!.nativeDecimalPlaces,
      nativeMetadataVersion: base!.nativeMetadataVersion,
      isBase: base!.isBase,
    };
    const createOrRead = await call(who, 'PUT', `/v1/accounting/currencies/${code}`, {
      body: { enabled: true },
      idempotencyKey: randomUUID(),
      etag: '*',
    });
    expect([201, 412]).toContain(createOrRead.status);
    const current =
      createOrRead.status === 201
        ? createOrRead
        : await call(who, 'GET', '/v1/accounting/currencies');
    const currentResource =
      createOrRead.status === 201
        ? resource(current)
        : (current.body.items as Array<Record<string, unknown>>).find(
            (item) => item.currencyCode === code,
          )!;
    const etag =
      createOrRead.status === 201 ? createOrRead.etag! : `"${currentResource.version as number}"`;

    const forbiddenMetadataWrite = await call(who, 'PUT', `/v1/accounting/currencies/${code}`, {
      body: { enabled: true, nativeDecimalPlaces: 9 },
      idempotencyKey: randomUUID(),
      etag,
    });
    expect([400, 422]).toContain(forbiddenMetadataWrite.status);

    const [left, right] = await Promise.all([
      call(who, 'PUT', `/v1/accounting/currencies/${code}`, {
        body: { enabled: false },
        idempotencyKey: randomUUID(),
        etag,
      }),
      call(who, 'PUT', `/v1/accounting/currencies/${code}`, {
        body: { enabled: true },
        idempotencyKey: randomUUID(),
        etag,
      }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 412]);
    const winnerResponse = left.status === 200 ? left : right;
    const winner = resource(winnerResponse);
    expect(winner).toEqual(expect.objectContaining(metadata));

    const sameKey = randomUUID();
    const sameBody = { enabled: winner.enabled !== true };
    const [firstReplay, secondReplay] = await Promise.all([
      call(who, 'PUT', `/v1/accounting/currencies/${code}`, {
        body: sameBody,
        idempotencyKey: sameKey,
        etag: winnerResponse.etag!,
      }),
      call(who, 'PUT', `/v1/accounting/currencies/${code}`, {
        body: sameBody,
        idempotencyKey: sameKey,
        etag: winnerResponse.etag!,
      }),
    ]);
    expect([firstReplay.status, secondReplay.status]).toEqual([200, 200]);
    expect(resource(firstReplay)).toEqual(resource(secondReplay));
    expect(firstReplay.body.operationId).toBe(secondReplay.body.operationId);
    expect(firstReplay.body.auditEventId).toBe(secondReplay.body.auditEventId);
    expect(resource(firstReplay)).toEqual(expect.objectContaining(metadata));
    if (resource(firstReplay).enabled !== true) {
      const restored = await call(who, 'PUT', `/v1/accounting/currencies/${code}`, {
        body: { enabled: true },
        idempotencyKey: randomUUID(),
        etag: firstReplay.etag!,
      });
      expect(restored.status).toBe(200);
      expect(resource(restored).enabled).toBe(true);
    }
    const after = await Promise.all(databases.map(ledgerDigest));
    expect(after).toEqual(before);
  });

  it('replays one simultaneous exact draft save and preserves both tenant ledger hashes', async () => {
    const who = userA1();
    const databases = tenantDatabases();
    const before = await Promise.all(databases.map(ledgerDigest));
    const capabilities = await call(who, 'GET', '/v1/accounting/capabilities');
    expect(capabilities.status).toBe(200);
    expect(capabilities.body).toEqual(
      expect.objectContaining({
        postingEnabled: false,
        reversalEnabled: false,
        openingPostingEnabled: false,
        periodEnforcementEnabled: false,
      }),
    );
    for (const forbidden of [
      '/v1/accounting/drafts/11111111-1111-4111-8111-111111111111/post',
      '/v1/accounting/entries/11111111-1111-4111-8111-111111111111/reverse',
    ]) {
      expect((await call(who, 'POST', forbidden, { idempotencyKey: randomUUID() })).status).toBe(
        404,
      );
    }

    const journal = await createJournal(who, 'EXACT-DRAFT');
    const account = await createAccount(who, 'EXACT-DRAFT');
    const currencies = await call(who, 'GET', '/v1/accounting/currencies');
    expect(currencies.status).toBe(200);
    const base = (currencies.body.items as Array<Record<string, unknown>>).find(
      (item) => item.isBase === true && item.enabled === true,
    )!;
    expect(base).toBeDefined();
    const exact = '10.123400';
    const body = {
      journalId: journal.value.id,
      accountingDate: '2026-11-07',
      description: 'T111 exact simultaneous draft',
      transactionType: 'manual_journal',
      lines: [
        {
          id: randomUUID(),
          sequence: 1,
          accountId: account.id,
          transactionCurrencyCode: base.currencyCode,
          transactionPrecision: base.nativeDecimalPlaces,
          transactionCurrencyMetadataVersion: base.nativeMetadataVersion,
          companyBaseCurrencyCode: base.currencyCode,
          basePrecision: base.nativeDecimalPlaces,
          baseCurrencyMetadataVersion: base.nativeMetadataVersion,
          currencyConfigurationVersion: base.version,
          transactionDebit: exact,
          transactionCredit: '0.000000',
          baseDebit: exact,
          baseCredit: '0.000000',
          rateReference: null,
          rateEffectiveDate: null,
          dimensions: [],
        },
        {
          id: randomUUID(),
          sequence: 2,
          accountId: account.id,
          transactionCurrencyCode: base.currencyCode,
          transactionPrecision: base.nativeDecimalPlaces,
          transactionCurrencyMetadataVersion: base.nativeMetadataVersion,
          companyBaseCurrencyCode: base.currencyCode,
          basePrecision: base.nativeDecimalPlaces,
          baseCurrencyMetadataVersion: base.nativeMetadataVersion,
          currencyConfigurationVersion: base.version,
          transactionDebit: '0.000000',
          transactionCredit: exact,
          baseDebit: '0.000000',
          baseCredit: exact,
          rateReference: null,
          rateEffectiveDate: null,
          dimensions: [],
        },
      ],
    };
    const key = randomUUID();
    const [first, second] = await Promise.all([
      call(who, 'POST', '/v1/accounting/drafts', { body, idempotencyKey: key }),
      call(who, 'POST', '/v1/accounting/drafts', { body, idempotencyKey: key }),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body).toEqual(second.body);
    const lines = resource(first).lines as Array<Record<string, unknown>>;
    expect(lines.map((line) => [line.transactionDebit, line.transactionCredit])).toEqual([
      [exact, '0.000000'],
      ['0.000000', exact],
    ]);
    expect(first.body.ledgerEffect).toBe('none');

    const draftId = resource(first).id as string;
    const etag = first.etag!;
    expect(etag).toMatch(/^"[1-9][0-9]*"$/);
    const [left, right] = await Promise.all([
      call(who, 'PUT', `/v1/accounting/drafts/${draftId}`, {
        body: { ...body, description: 'T111 left stale-version contender' },
        idempotencyKey: randomUUID(),
        etag,
      }),
      call(who, 'PUT', `/v1/accounting/drafts/${draftId}`, {
        body: { ...body, description: 'T111 right stale-version contender' },
        idempotencyKey: randomUUID(),
        etag,
      }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 412]);
    const winner = resource(left.status === 200 ? left : right);
    const winnerLines = winner.lines as Array<Record<string, unknown>>;
    expect(winnerLines.map((line) => [line.transactionDebit, line.transactionCredit])).toEqual([
      [exact, '0.000000'],
      ['0.000000', exact],
    ]);
    expect((left.status === 412 ? left : right).body).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/STALE|PRECONDITION/) }),
    );
    const after = await Promise.all(databases.map(ledgerDigest));
    expect(after).toEqual(before);
  });
});
