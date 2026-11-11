import {
  AccountingFoundationOwnedResourceRegistry,
  prepareAccountingFoundationStoryOneTenants,
  prepareAccountingFoundationStoryTwoTenants,
  prepareAccountingFoundationStoryThreeTenants,
  createAccountingFoundationOwnershipRegistry,
  reserveDynamicLoopbackPort,
  waitForAccountingFoundationReadiness,
  type AccountingFoundationReadinessTarget,
} from './accounting-foundation-live-fixture';

interface ExpectedOwnedRecord {
  ownershipLabel: string;
}

interface ExpectedOwnershipRegistry {
  runId: string;
  ownershipLabel: string;
  tenants: Array<ExpectedOwnedRecord & { key: string; tenantId: string }>;
  users: Array<ExpectedOwnedRecord & { key: string; subjectId: string }>;
  memberships: Array<
    ExpectedOwnedRecord & { membershipId: string; subjectId: string; tenantId: string }
  >;
  databases: Array<ExpectedOwnedRecord & { key: string; databaseName: string; tenantId: string }>;
  routes: Array<ExpectedOwnedRecord & { routeId: string; tenantId: string; databaseName: string }>;
  companies: Array<ExpectedOwnedRecord & { key: string; companyId: string; tenantId: string }>;
}

const RUN_ID = 'af-t003-0001';
const OWNERSHIP_LABEL = `com.kemfai.accounting-foundation.run=${RUN_ID}`;
const TENANT_A_ID = '30000000-0000-4000-8000-00000000000a';
const TENANT_B_ID = '30000000-0000-4000-8000-00000000000b';
const USER_A_SUBJECT_ID = '30000000-0000-4000-8000-00000000001a';
const USER_B_SUBJECT_ID = '30000000-0000-4000-8000-00000000001b';
const MEMBERSHIP_A_ID = '30000000-0000-4000-8000-00000000002a';
const MEMBERSHIP_B_ID = '30000000-0000-4000-8000-00000000002b';
const ROUTE_A_ID = '30000000-0000-4000-8000-00000000003a';
const ROUTE_B_ID = '30000000-0000-4000-8000-00000000003b';
const COMPANY_A1_ID = '30000000-0000-4000-8000-0000000000a1';
const COMPANY_A2_ID = '30000000-0000-4000-8000-0000000000a2';
const COMPANY_B1_ID = '30000000-0000-4000-8000-0000000000b1';
const TENANT_A_DATABASE = `${RUN_ID}_tenant_a_db`;
const TENANT_B_DATABASE = `${RUN_ID}_tenant_b_db`;

function exactOwnedTopology() {
  return {
    runId: RUN_ID,
    ownershipLabel: OWNERSHIP_LABEL,
    tenants: [
      { key: 'tenant-a', tenantId: TENANT_A_ID },
      { key: 'tenant-b', tenantId: TENANT_B_ID },
    ],
    users: [
      { key: 'user-a', subjectId: USER_A_SUBJECT_ID },
      { key: 'user-b', subjectId: USER_B_SUBJECT_ID },
    ],
    memberships: [
      { membershipId: MEMBERSHIP_A_ID, subjectId: USER_A_SUBJECT_ID, tenantId: TENANT_A_ID },
      { membershipId: MEMBERSHIP_B_ID, subjectId: USER_B_SUBJECT_ID, tenantId: TENANT_B_ID },
    ],
    databases: [
      { key: 'tenant-a-db', databaseName: TENANT_A_DATABASE, tenantId: TENANT_A_ID },
      { key: 'tenant-b-db', databaseName: TENANT_B_DATABASE, tenantId: TENANT_B_ID },
    ],
    routes: [
      { routeId: ROUTE_A_ID, tenantId: TENANT_A_ID, databaseName: TENANT_A_DATABASE },
      { routeId: ROUTE_B_ID, tenantId: TENANT_B_ID, databaseName: TENANT_B_DATABASE },
    ],
    companies: [
      { key: 'company-a1', companyId: COMPANY_A1_ID, tenantId: TENANT_A_ID },
      { key: 'company-a2', companyId: COMPANY_A2_ID, tenantId: TENANT_A_ID },
      { key: 'company-b1', companyId: COMPANY_B1_ID, tenantId: TENANT_B_ID },
    ],
  } as const;
}

describe('accounting-foundation exact-owned live fixture registry', () => {
  it('registers exactly two real users with disjoint tenant memberships and routes', () => {
    const registry: ExpectedOwnershipRegistry =
      createAccountingFoundationOwnershipRegistry(exactOwnedTopology());

    expect(registry.users).toHaveLength(2);
    expect(registry.memberships).toHaveLength(2);
    expect(registry.routes).toHaveLength(2);
    expect(registry.databases).toHaveLength(2);
    expect(registry.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          membershipId: MEMBERSHIP_A_ID,
          subjectId: USER_A_SUBJECT_ID,
          tenantId: TENANT_A_ID,
        }),
        expect.objectContaining({
          membershipId: MEMBERSHIP_B_ID,
          subjectId: USER_B_SUBJECT_ID,
          tenantId: TENANT_B_ID,
        }),
      ]),
    );
    expect(registry.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: ROUTE_A_ID,
          tenantId: TENANT_A_ID,
          databaseName: TENANT_A_DATABASE,
        }),
        expect.objectContaining({
          routeId: ROUTE_B_ID,
          tenantId: TENANT_B_ID,
          databaseName: TENANT_B_DATABASE,
        }),
      ]),
    );

    const tenantBySubject = new Map(
      registry.memberships.map((membership) => [membership.subjectId, membership.tenantId]),
    );
    expect(tenantBySubject.get(USER_A_SUBJECT_ID)).toBe(TENANT_A_ID);
    expect(tenantBySubject.get(USER_B_SUBJECT_ID)).toBe(TENANT_B_ID);
    expect(tenantBySubject.get(USER_A_SUBJECT_ID)).not.toBe(tenantBySubject.get(USER_B_SUBJECT_ID));
  });

  it('owns distinct tenant databases and exactly Companies A1, A2, and B1', () => {
    const registry: ExpectedOwnershipRegistry =
      createAccountingFoundationOwnershipRegistry(exactOwnedTopology());

    expect(new Set(registry.databases.map(({ databaseName }) => databaseName))).toEqual(
      new Set([TENANT_A_DATABASE, TENANT_B_DATABASE]),
    );
    expect(registry.companies).toHaveLength(3);
    expect(registry.companies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'company-a1',
          companyId: COMPANY_A1_ID,
          tenantId: TENANT_A_ID,
        }),
        expect.objectContaining({
          key: 'company-a2',
          companyId: COMPANY_A2_ID,
          tenantId: TENANT_A_ID,
        }),
        expect.objectContaining({
          key: 'company-b1',
          companyId: COMPANY_B1_ID,
          tenantId: TENANT_B_ID,
        }),
      ]),
    );
    expect(
      registry.companies
        .filter(({ tenantId }) => tenantId === TENANT_A_ID)
        .map(({ companyId }) => companyId),
    ).toEqual([COMPANY_A1_ID, COMPANY_A2_ID]);
    expect(
      registry.companies
        .filter(({ tenantId }) => tenantId === TENANT_B_ID)
        .map(({ companyId }) => companyId),
    ).toEqual([COMPANY_B1_ID]);
  });

  it('stamps every owned record with the one exact run ownership label', () => {
    const registry: ExpectedOwnershipRegistry =
      createAccountingFoundationOwnershipRegistry(exactOwnedTopology());
    const ownedRecords = [
      ...registry.tenants,
      ...registry.users,
      ...registry.memberships,
      ...registry.databases,
      ...registry.routes,
      ...registry.companies,
    ];

    expect(registry.runId).toBe(RUN_ID);
    expect(registry.ownershipLabel).toBe(OWNERSHIP_LABEL);
    expect(ownedRecords).not.toHaveLength(0);
    expect(ownedRecords.every(({ ownershipLabel }) => ownershipLabel === OWNERSHIP_LABEL)).toBe(
      true,
    );
  });

  it.each([
    [
      'one subject reused for both users',
      (topology: ReturnType<typeof exactOwnedTopology>) => ({
        ...topology,
        users: [topology.users[0], { ...topology.users[1], subjectId: USER_A_SUBJECT_ID }],
      }),
    ],
    [
      'one membership reused across tenants',
      (topology: ReturnType<typeof exactOwnedTopology>) => ({
        ...topology,
        memberships: [
          topology.memberships[0],
          { ...topology.memberships[1], membershipId: MEMBERSHIP_A_ID },
        ],
      }),
    ],
    [
      'one route reused across tenants',
      (topology: ReturnType<typeof exactOwnedTopology>) => ({
        ...topology,
        routes: [topology.routes[0], { ...topology.routes[1], routeId: ROUTE_A_ID }],
      }),
    ],
    [
      'one database reused across tenants',
      (topology: ReturnType<typeof exactOwnedTopology>) => ({
        ...topology,
        databases: [
          topology.databases[0],
          { ...topology.databases[1], databaseName: TENANT_A_DATABASE },
        ],
        routes: [topology.routes[0], { ...topology.routes[1], databaseName: TENANT_A_DATABASE }],
      }),
    ],
    [
      'one company reused across tenants',
      (topology: ReturnType<typeof exactOwnedTopology>) => ({
        ...topology,
        companies: [
          topology.companies[0],
          topology.companies[1],
          { ...topology.companies[2], companyId: COMPANY_A1_ID },
        ],
      }),
    ],
  ])('rejects a topology with %s', (_case, mutate) => {
    expect(() => createAccountingFoundationOwnershipRegistry(mutate(exactOwnedTopology()))).toThrow(
      /disjoint|duplicate|ownership|topology/i,
    );
  });

  it.each([
    [
      'User B membership pointing at Tenant A',
      (topology: ReturnType<typeof exactOwnedTopology>) => ({
        ...topology,
        memberships: [
          topology.memberships[0],
          { ...topology.memberships[1], tenantId: TENANT_A_ID },
        ],
      }),
    ],
    [
      'Tenant B route pointing at Tenant A database',
      (topology: ReturnType<typeof exactOwnedTopology>) => ({
        ...topology,
        routes: [topology.routes[0], { ...topology.routes[1], databaseName: TENANT_A_DATABASE }],
      }),
    ],
    [
      'Company B1 assigned to Tenant A',
      (topology: ReturnType<typeof exactOwnedTopology>) => ({
        ...topology,
        companies: [
          topology.companies[0],
          topology.companies[1],
          { ...topology.companies[2], tenantId: TENANT_A_ID },
        ],
      }),
    ],
  ])('rejects cross-tenant aliasing: %s', (_case, mutate) => {
    expect(() => createAccountingFoundationOwnershipRegistry(mutate(exactOwnedTopology()))).toThrow(
      /membership|route|company|tenant|topology/i,
    );
  });
});

describe('accounting-foundation owned resource lifecycle', () => {
  it('requires registration before creation for every owned resource kind', () => {
    const registry = new AccountingFoundationOwnedResourceRegistry(RUN_ID);
    const kinds = [
      'database',
      'route',
      'identity',
      'membership',
      'company',
      'process-group',
      'container',
      'network',
      'volume',
      'realm',
      'client',
      'private-file',
      'port',
    ] as const;

    expect(() => registry.markCreated('database', 'unregistered')).toThrow(
      /registered before creation/,
    );
    for (const kind of kinds) {
      registry.register(kind, `${kind}-owned`, { runId: RUN_ID });
      registry.markCreated(kind, `${kind}-owned`);
    }

    const snapshot = registry.snapshot();
    expect(snapshot).toHaveLength(kinds.length);
    expect(snapshot.every(({ created }) => created)).toBe(true);
    expect(snapshot.every(({ ownershipLabel }) => ownershipLabel === OWNERSHIP_LABEL)).toBe(true);
    expect(() => registry.register('database', 'database-owned')).toThrow(/duplicate/);
  });

  it('reserves distinct operating-system-selected IPv4 loopback ports', async () => {
    const postgres = await reserveDynamicLoopbackPort('postgres');
    const redis = await reserveDynamicLoopbackPort('redis');
    try {
      expect(postgres.host).toBe('127.0.0.1');
      expect(redis.host).toBe('127.0.0.1');
      expect(postgres.port).toBeGreaterThan(0);
      expect(redis.port).toBeGreaterThan(0);
      expect(postgres.port).not.toBe(redis.port);
    } finally {
      await Promise.all([postgres.release(), redis.release()]);
    }
  });
});

const READINESS_NAMES = [
  'control-db',
  'redis',
  'keycloak',
  'odoo',
  'nest',
  'next',
  'tenant-a-route',
  'tenant-b-route',
  'user-a-session',
  'user-b-session',
] as const;

function readyTargets(
  probeOverrides: Partial<
    Record<(typeof READINESS_NAMES)[number], AccountingFoundationReadinessTarget['probe']>
  > = {},
): AccountingFoundationReadinessTarget[] {
  return READINESS_NAMES.map((name) => {
    const target: AccountingFoundationReadinessTarget = {
      name,
      probe: probeOverrides[name] ?? (async () => ({ ready: true })),
    };
    if (name === 'tenant-a-route') {
      Object.assign(target, {
        expectedDatabaseName: TENANT_A_DATABASE,
        requiredAddons: ['kemfai_tenant_core'],
        expectedCompanyIds: [COMPANY_A1_ID, COMPANY_A2_ID],
        probe:
          probeOverrides[name] ??
          (async () => ({
            ready: true,
            databaseName: TENANT_A_DATABASE,
            installedAddons: ['kemfai_tenant_core'],
            companyIds: [COMPANY_A1_ID, COMPANY_A2_ID],
          })),
      });
    }
    if (name === 'tenant-b-route') {
      Object.assign(target, {
        expectedDatabaseName: TENANT_B_DATABASE,
        requiredAddons: ['kemfai_tenant_core'],
        expectedCompanyIds: [COMPANY_B1_ID],
        probe:
          probeOverrides[name] ??
          (async () => ({
            ready: true,
            databaseName: TENANT_B_DATABASE,
            installedAddons: ['kemfai_tenant_core'],
            companyIds: [COMPANY_B1_ID],
          })),
      });
    }
    if (name === 'user-a-session') {
      target.expectedSubjectId = USER_A_SUBJECT_ID;
      target.probe =
        probeOverrides[name] ??
        (async () => ({ ready: true, authenticatedSubjectId: USER_A_SUBJECT_ID }));
    }
    if (name === 'user-b-session') {
      target.expectedSubjectId = USER_B_SUBJECT_ID;
      target.probe =
        probeOverrides[name] ??
        (async () => ({ ready: true, authenticatedSubjectId: USER_B_SUBJECT_ID }));
    }
    return target;
  });
}

describe('accounting-foundation independent bounded readiness', () => {
  it('proves every service, routed tenant database/company set, and authenticated user', async () => {
    const calls = new Map<string, number>();
    const targets = readyTargets();
    for (const target of targets) {
      const probe = target.probe;
      target.probe = async () => {
        calls.set(target.name, (calls.get(target.name) ?? 0) + 1);
        return probe();
      };
    }

    const receipts = await waitForAccountingFoundationReadiness({
      targets,
      timeoutMs: 1_000,
      intervalMs: 10,
    });

    expect(receipts.map(({ name }) => name).sort()).toEqual([...READINESS_NAMES].sort());
    expect(receipts.every(({ observation }) => observation.ready)).toBe(true);
    expect([...calls.values()]).toEqual(Array(READINESS_NAMES.length).fill(1));
  });

  it('rejects a missing or duplicate readiness target', async () => {
    const missing = readyTargets().slice(1);
    await expect(
      waitForAccountingFoundationReadiness({ targets: missing, timeoutMs: 100, intervalMs: 10 }),
    ).rejects.toThrow(/exactly/);

    const duplicate = readyTargets();
    duplicate[1] = duplicate[0];
    await expect(
      waitForAccountingFoundationReadiness({ targets: duplicate, timeoutMs: 100, intervalMs: 10 }),
    ).rejects.toThrow(/exactly|duplicate/);
  });

  it('times out the specific route when its real database/addon/company evidence mismatches', async () => {
    let now = 0;
    const targets = readyTargets({
      'tenant-b-route': async () => ({
        ready: true,
        databaseName: TENANT_A_DATABASE,
        installedAddons: ['kemfai_tenant_core'],
        companyIds: [COMPANY_A1_ID],
        detail: 'wrong routed tenant',
      }),
    });

    await expect(
      waitForAccountingFoundationReadiness({
        targets,
        timeoutMs: 30,
        intervalMs: 10,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).rejects.toThrow(/tenant-b-route.*wrong routed tenant/);
    expect(now).toBeLessThanOrEqual(30);
  });

  it('rejects unbounded or invalid timing configuration', async () => {
    await expect(
      waitForAccountingFoundationReadiness({
        targets: readyTargets(),
        timeoutMs: 300_001,
        intervalMs: 10,
      }),
    ).rejects.toThrow(/bounded/);
    await expect(
      waitForAccountingFoundationReadiness({
        targets: readyTargets(),
        timeoutMs: 100,
        intervalMs: 101,
      }),
    ).rejects.toThrow(/interval/);
  });
});

describe('accounting-foundation Story 1 addon preparation (T046)', () => {
  it('installs or upgrades both routed tenant DBs and proves version, models, and companies before browser start', async () => {
    const calls: Array<{ database: string; model: string; method: string; args: unknown[] }> = [];
    const moduleReads = new Map<string, number>();
    const browserStart = jest.fn(async () => 'browser-started');
    const storyOneModels = [
      'account.account',
      'kemfai.account.audit.event',
      'kemfai.account.mutation.receipt',
      'kemfai.account.draft',
      'kemfai.account.draft.line',
    ];
    const rpc = {
      authenticate: jest.fn(async (database: string) => (database === TENANT_A_DATABASE ? 11 : 22)),
      executeKw: jest.fn(
        async (
          database: string,
          _uid: number,
          _password: string,
          model: string,
          method: string,
          args: unknown[] = [],
        ) => {
          calls.push({ database, model, method, args });
          if (model === 'ir.module.module' && method === 'search_read') {
            const read = (moduleReads.get(database) ?? 0) + 1;
            moduleReads.set(database, read);
            return [
              {
                id: database === TENANT_A_DATABASE ? 41 : 42,
                name: 'kemfai_accounting',
                state: read > 1 || database === TENANT_B_DATABASE ? 'installed' : 'uninstalled',
                installed_version:
                  read > 1 || database === TENANT_B_DATABASE ? '18.0.1.0.0' : false,
                latest_version: '18.0.1.0.0',
              },
            ];
          }
          if (model === 'ir.module.module' && method.startsWith('button_immediate_')) return true;
          if (storyOneModels.includes(model) && method === 'fields_get') return { id: {} };
          if (model === 'res.company' && method === 'search') {
            return database === TENANT_A_DATABASE ? [101, 102] : [201];
          }
          throw new Error(`Unexpected RPC ${database}:${model}.${method}`);
        },
      ),
    };

    const result = await prepareAccountingFoundationStoryOneTenants({
      rpc,
      credentials: { login: 'fixture-admin', password: 'fixture-password' },
      tenants: [
        {
          key: 'tenant-a',
          databaseName: TENANT_A_DATABASE,
          expectedCompanyIds: [101, 102],
        },
        { key: 'tenant-b', databaseName: TENANT_B_DATABASE, expectedCompanyIds: [201] },
      ],
      startBrowser: browserStart,
    });

    expect(result.browser).toBe('browser-started');
    expect(result.tenants).toEqual([
      expect.objectContaining({
        key: 'tenant-a',
        databaseName: TENANT_A_DATABASE,
        installedVersion: '18.0.1.0.0',
        companyIds: [101, 102],
      }),
      expect.objectContaining({
        key: 'tenant-b',
        databaseName: TENANT_B_DATABASE,
        installedVersion: '18.0.1.0.0',
        companyIds: [201],
      }),
    ]);
    expect(
      calls.some(
        (call) => call.database === TENANT_A_DATABASE && call.method === 'button_immediate_install',
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.database === TENANT_B_DATABASE && call.method === 'button_immediate_upgrade',
      ),
    ).toBe(true);
    for (const database of [TENANT_A_DATABASE, TENANT_B_DATABASE]) {
      expect(
        calls
          .filter(
            (call) =>
              call.database === database &&
              call.method === 'fields_get' &&
              storyOneModels.includes(call.model),
          )
          .map(({ model }) => model),
      ).toEqual(storyOneModels);
    }
    const browserOrder = browserStart.mock.invocationCallOrder[0];
    expect(browserOrder).toBeGreaterThan(rpc.executeKw.mock.invocationCallOrder.at(-1) ?? 0);
  });
});

describe('accounting-foundation Story 2 addon preparation (T089)', () => {
  it('installs dimensions before accounting and proves both addons, all models, and routed companies before browser start', async () => {
    const calls: Array<{ database: string; model: string; method: string; args: unknown[] }> = [];
    const moduleReads = new Map<string, number>();
    const browserStart = jest.fn(async () => 'story-2-browser-started');
    const storyTwoModels = [
      'account.account',
      'kemfai.account.audit.event',
      'kemfai.account.mutation.receipt',
      'kemfai.account.draft',
      'kemfai.account.draft.line',
      'kemfai.dimension.definition',
      'kemfai.dimension.value',
      'kemfai.dimension.rule',
      'kemfai.account.draft.dimension',
    ];
    const rpc = {
      authenticate: jest.fn(async (database: string) => (database === TENANT_A_DATABASE ? 11 : 22)),
      executeKw: jest.fn(
        async (
          database: string,
          _uid: number,
          _password: string,
          model: string,
          method: string,
          args: unknown[] = [],
        ) => {
          calls.push({ database, model, method, args });
          if (model === 'ir.module.module' && method === 'search_read') {
            const addonName = (args[0] as string[][])[0][2];
            const key = `${database}:${addonName}`;
            const read = (moduleReads.get(key) ?? 0) + 1;
            moduleReads.set(key, read);
            return [
              {
                id: addonName === 'kemfai_dimensions' ? 51 : 52,
                name: addonName,
                state:
                  read > 1
                    ? 'installed'
                    : addonName === 'kemfai_dimensions'
                      ? 'uninstalled'
                      : 'installed',
                installed_version:
                  read > 1 || addonName === 'kemfai_accounting' ? '18.0.1.0.0' : false,
                latest_version: '18.0.1.0.0',
              },
            ];
          }
          if (model === 'ir.module.module' && method.startsWith('button_immediate_')) return true;
          if (storyTwoModels.includes(model) && method === 'fields_get') return { id: {} };
          if (model === 'res.company' && method === 'search') {
            return database === TENANT_A_DATABASE ? [101, 102] : [201];
          }
          throw new Error(`Unexpected RPC ${database}:${model}.${method}`);
        },
      ),
    };

    const result = await prepareAccountingFoundationStoryTwoTenants({
      rpc,
      credentials: { login: 'fixture-admin', password: 'fixture-password' },
      tenants: [
        { key: 'tenant-a', databaseName: TENANT_A_DATABASE, expectedCompanyIds: [101, 102] },
        { key: 'tenant-b', databaseName: TENANT_B_DATABASE, expectedCompanyIds: [201] },
      ],
      startBrowser: browserStart,
    });

    expect(result.browser).toBe('story-2-browser-started');
    for (const tenant of result.tenants) {
      expect(tenant.installedVersions).toEqual({
        kemfai_dimensions: '18.0.1.0.0',
        kemfai_accounting: '18.0.1.0.0',
      });
      expect(tenant.callableModels).toEqual(storyTwoModels);
    }
    for (const database of [TENANT_A_DATABASE, TENANT_B_DATABASE]) {
      const addonActions = calls.filter(
        (call) =>
          call.database === database &&
          call.model === 'ir.module.module' &&
          call.method.startsWith('button_immediate_'),
      );
      expect(addonActions.map(({ args }) => args)).toEqual([[[51]], [[52]]]);
      expect(addonActions.map(({ method }) => method).sort()).toEqual([
        'button_immediate_install',
        'button_immediate_upgrade',
      ]);
      expect(
        calls
          .filter((call) => call.database === database && call.method === 'fields_get')
          .map(({ model }) => model),
      ).toEqual(storyTwoModels);
    }
    expect(browserStart.mock.invocationCallOrder[0]).toBeGreaterThan(
      rpc.executeKw.mock.invocationCallOrder.at(-1) ?? 0,
    );
  });
});

describe('accounting-foundation Story 3 addon preparation (T121)', () => {
  it('upgrades both complete tenant addons and proves Story 3 models and routed companies before browser start', async () => {
    const calls: Array<{ database: string; model: string; method: string; args: unknown[] }> = [];
    const moduleReads = new Map<string, number>();
    const browserStart = jest.fn(async () => 'story-3-browser-started');
    const storyThreeModels = [
      'account.account',
      'kemfai.account.audit.event',
      'kemfai.account.mutation.receipt',
      'kemfai.account.draft',
      'kemfai.account.draft.line',
      'kemfai.dimension.definition',
      'kemfai.dimension.value',
      'kemfai.dimension.rule',
      'kemfai.account.draft.dimension',
      'account.journal',
      'kemfai.account.currency.config',
      'kemfai.account.draft.validation',
    ];
    const rpc = {
      authenticate: jest.fn(async (database: string) => (database === TENANT_A_DATABASE ? 11 : 22)),
      executeKw: jest.fn(
        async (
          database: string,
          _uid: number,
          _password: string,
          model: string,
          method: string,
          args: unknown[] = [],
        ) => {
          calls.push({ database, model, method, args });
          if (model === 'ir.module.module' && method === 'search_read') {
            const addonName = (args[0] as string[][])[0][2];
            const key = `${database}:${addonName}`;
            const read = (moduleReads.get(key) ?? 0) + 1;
            moduleReads.set(key, read);
            return [
              {
                id: addonName === 'kemfai_dimensions' ? 61 : 62,
                name: addonName,
                state: 'installed',
                installed_version: '18.0.1.0.0',
                latest_version: '18.0.1.0.0',
              },
            ];
          }
          if (model === 'ir.module.module' && method === 'button_immediate_upgrade') return true;
          if (storyThreeModels.includes(model) && method === 'fields_get') return { id: {} };
          if (model === 'res.company' && method === 'search') {
            return database === TENANT_A_DATABASE ? [101, 102] : [201];
          }
          throw new Error(`Unexpected RPC ${database}:${model}.${method}`);
        },
      ),
    };

    const result = await prepareAccountingFoundationStoryThreeTenants({
      rpc,
      credentials: { login: 'fixture-admin', password: 'fixture-password' },
      tenants: [
        { key: 'tenant-a', databaseName: TENANT_A_DATABASE, expectedCompanyIds: [101, 102] },
        { key: 'tenant-b', databaseName: TENANT_B_DATABASE, expectedCompanyIds: [201] },
      ],
      startBrowser: browserStart,
    });

    expect(result.browser).toBe('story-3-browser-started');
    for (const tenant of result.tenants) {
      expect(tenant.installedVersions).toEqual({
        kemfai_dimensions: '18.0.1.0.0',
        kemfai_accounting: '18.0.1.0.0',
      });
      expect(tenant.callableModels).toEqual(storyThreeModels);
    }
    for (const database of [TENANT_A_DATABASE, TENANT_B_DATABASE]) {
      expect(
        calls
          .filter(
            (call) =>
              call.database === database &&
              call.model === 'ir.module.module' &&
              call.method === 'button_immediate_upgrade',
          )
          .map(({ args }) => args),
      ).toEqual([[[61]], [[62]]]);
      expect(
        calls
          .filter((call) => call.database === database && call.method === 'fields_get')
          .map(({ model }) => model),
      ).toEqual(storyThreeModels);
      expect(
        calls.findIndex(
          (call) =>
            call.database === database &&
            call.model === 'kemfai.account.draft.validation' &&
            call.method === 'fields_get',
        ),
      ).toBeLessThan(
        calls.findIndex(
          (call) =>
            call.database === database && call.model === 'res.company' && call.method === 'search',
        ),
      );
    }
    expect(browserStart.mock.invocationCallOrder[0]).toBeGreaterThan(
      rpc.executeKw.mock.invocationCallOrder.at(-1) ?? 0,
    );
  });
});
