import { createServer, Server } from 'node:net';

export const ACCOUNTING_FOUNDATION_OWNERSHIP_LABEL_PREFIX = 'com.kemfai.accounting-foundation.run=';

export const ACCOUNTING_FOUNDATION_STORY_ONE_MODELS = [
  'account.account',
  'kemfai.account.audit.event',
  'kemfai.account.mutation.receipt',
  'kemfai.account.draft',
  'kemfai.account.draft.line',
] as const;

export const ACCOUNTING_FOUNDATION_STORY_TWO_MODELS = [
  ...ACCOUNTING_FOUNDATION_STORY_ONE_MODELS,
  'kemfai.dimension.definition',
  'kemfai.dimension.value',
  'kemfai.dimension.rule',
  'kemfai.account.draft.dimension',
] as const;

export const ACCOUNTING_FOUNDATION_STORY_THREE_MODELS = [
  ...ACCOUNTING_FOUNDATION_STORY_TWO_MODELS,
  'account.journal',
  'kemfai.account.currency.config',
  'kemfai.account.draft.validation',
] as const;

interface AccountingFoundationFixtureOdooRpc {
  authenticate(database: string, login: string, password: string): Promise<number>;
  executeKw(
    database: string,
    uid: number,
    password: string,
    model: string,
    method: string,
    args?: unknown[],
  ): Promise<unknown>;
}

export interface AccountingFoundationStoryOneTenantInput {
  key: 'tenant-a' | 'tenant-b';
  databaseName: string;
  expectedCompanyIds: readonly number[];
}

export interface AccountingFoundationStoryOneTenantReceipt {
  key: 'tenant-a' | 'tenant-b';
  databaseName: string;
  installedVersion: string;
  companyIds: number[];
  callableModels: readonly string[];
}

export interface AccountingFoundationStoryTwoTenantReceipt {
  key: 'tenant-a' | 'tenant-b';
  databaseName: string;
  installedVersions: Readonly<Record<'kemfai_dimensions' | 'kemfai_accounting', string>>;
  companyIds: number[];
  callableModels: readonly string[];
}

export type AccountingFoundationStoryThreeTenantReceipt = AccountingFoundationStoryTwoTenantReceipt;

export interface AccountingFoundationStoryOnePreparationOptions<TBrowser> {
  rpc: AccountingFoundationFixtureOdooRpc;
  credentials: { login: string; password: string };
  tenants: readonly AccountingFoundationStoryOneTenantInput[];
  startBrowser(): Promise<TBrowser>;
}

type AccountingAddonRow = {
  id: number;
  name: string;
  state: string;
  installed_version: string | false;
  latest_version: string | false;
};

function requireAccountingAddonRow(
  value: unknown,
  databaseName: string,
  addonName: string,
): AccountingAddonRow {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${databaseName}: expected exactly one ${addonName} addon`);
  }
  const row = value[0] as Partial<AccountingAddonRow>;
  if (!Number.isInteger(row.id) || row.name !== addonName || typeof row.state !== 'string') {
    throw new Error(`${databaseName}: invalid ${addonName} addon metadata`);
  }
  return row as AccountingAddonRow;
}

function sortedNumbers(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right);
}

async function prepareTenantAddons(
  rpc: AccountingFoundationFixtureOdooRpc,
  credentials: { login: string; password: string },
  tenant: AccountingFoundationStoryOneTenantInput,
  addonNames: readonly string[],
  callableModels: readonly string[],
): Promise<{
  installedVersions: Record<string, string>;
  companyIds: number[];
}> {
  const uid = await rpc.authenticate(tenant.databaseName, credentials.login, credentials.password);
  const installedVersions: Record<string, string> = {};

  for (const addonName of addonNames) {
    const readAddon = async () =>
      requireAccountingAddonRow(
        await rpc.executeKw(
          tenant.databaseName,
          uid,
          credentials.password,
          'ir.module.module',
          'search_read',
          [
            [['name', '=', addonName]],
            ['id', 'name', 'state', 'installed_version', 'latest_version'],
          ],
        ),
        tenant.databaseName,
        addonName,
      );

    const before = await readAddon();
    if (before.state === 'installed') {
      await rpc.executeKw(
        tenant.databaseName,
        uid,
        credentials.password,
        'ir.module.module',
        'button_immediate_upgrade',
        [[before.id]],
      );
    } else if (before.state === 'uninstalled' || before.state === 'to install') {
      await rpc.executeKw(
        tenant.databaseName,
        uid,
        credentials.password,
        'ir.module.module',
        'button_immediate_install',
        [[before.id]],
      );
    } else {
      throw new Error(
        `${tenant.databaseName}: ${addonName} is not safely installable from ${before.state}`,
      );
    }

    const installed = await readAddon();
    if (
      installed.state !== 'installed' ||
      typeof installed.installed_version !== 'string' ||
      !installed.installed_version.trim() ||
      (typeof installed.latest_version === 'string' &&
        installed.latest_version.trim() &&
        installed.installed_version !== installed.latest_version)
    ) {
      throw new Error(`${tenant.databaseName}: ${addonName} installed version is not current`);
    }
    installedVersions[addonName] = installed.installed_version;
  }

  for (const model of callableModels) {
    const fields = await rpc.executeKw(
      tenant.databaseName,
      uid,
      credentials.password,
      model,
      'fields_get',
      [],
    );
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error(`${tenant.databaseName}: addon model is not callable: ${model}`);
    }
  }

  const companyIds = await rpc.executeKw(
    tenant.databaseName,
    uid,
    credentials.password,
    'res.company',
    'search',
    [[]],
  );
  if (
    !Array.isArray(companyIds) ||
    companyIds.some((companyId) => !Number.isInteger(companyId)) ||
    JSON.stringify(sortedNumbers(companyIds as number[])) !==
      JSON.stringify(sortedNumbers(tenant.expectedCompanyIds))
  ) {
    throw new Error(`${tenant.databaseName}: routed company readiness mismatch`);
  }

  return { installedVersions, companyIds: companyIds as number[] };
}

function validatePreparationTenants(
  tenants: readonly AccountingFoundationStoryOneTenantInput[],
): void {
  requireExactKeys(
    tenants.map(({ key }) => key),
    ['tenant-a', 'tenant-b'],
    'accounting-foundation tenant',
  );
  requireUnique(
    tenants.map(({ databaseName }) => databaseName),
    'accounting-foundation tenant database',
  );
}

export async function prepareAccountingFoundationStoryOneTenants<TBrowser>(
  options: AccountingFoundationStoryOnePreparationOptions<TBrowser>,
): Promise<{ tenants: AccountingFoundationStoryOneTenantReceipt[]; browser: TBrowser }> {
  validatePreparationTenants(options.tenants);
  const tenants: AccountingFoundationStoryOneTenantReceipt[] = [];
  for (const tenant of options.tenants) {
    const prepared = await prepareTenantAddons(
      options.rpc,
      options.credentials,
      tenant,
      ['kemfai_accounting'],
      ACCOUNTING_FOUNDATION_STORY_ONE_MODELS,
    );
    tenants.push({
      key: tenant.key,
      databaseName: tenant.databaseName,
      installedVersion: prepared.installedVersions.kemfai_accounting,
      companyIds: prepared.companyIds,
      callableModels: ACCOUNTING_FOUNDATION_STORY_ONE_MODELS,
    });
  }
  const browser = await options.startBrowser();
  return { tenants, browser };
}

export async function prepareAccountingFoundationStoryTwoTenants<TBrowser>(
  options: AccountingFoundationStoryOnePreparationOptions<TBrowser>,
): Promise<{ tenants: AccountingFoundationStoryTwoTenantReceipt[]; browser: TBrowser }> {
  validatePreparationTenants(options.tenants);
  const tenants: AccountingFoundationStoryTwoTenantReceipt[] = [];
  for (const tenant of options.tenants) {
    const prepared = await prepareTenantAddons(
      options.rpc,
      options.credentials,
      tenant,
      ['kemfai_dimensions', 'kemfai_accounting'],
      ACCOUNTING_FOUNDATION_STORY_TWO_MODELS,
    );
    tenants.push({
      key: tenant.key,
      databaseName: tenant.databaseName,
      installedVersions: {
        kemfai_dimensions: prepared.installedVersions.kemfai_dimensions,
        kemfai_accounting: prepared.installedVersions.kemfai_accounting,
      },
      companyIds: prepared.companyIds,
      callableModels: ACCOUNTING_FOUNDATION_STORY_TWO_MODELS,
    });
  }
  const browser = await options.startBrowser();
  return { tenants, browser };
}

export async function prepareAccountingFoundationStoryThreeTenants<TBrowser>(
  options: AccountingFoundationStoryOnePreparationOptions<TBrowser>,
): Promise<{ tenants: AccountingFoundationStoryThreeTenantReceipt[]; browser: TBrowser }> {
  validatePreparationTenants(options.tenants);
  const tenants: AccountingFoundationStoryThreeTenantReceipt[] = [];
  for (const tenant of options.tenants) {
    const prepared = await prepareTenantAddons(
      options.rpc,
      options.credentials,
      tenant,
      ['kemfai_dimensions', 'kemfai_accounting'],
      ACCOUNTING_FOUNDATION_STORY_THREE_MODELS,
    );
    tenants.push({
      key: tenant.key,
      databaseName: tenant.databaseName,
      installedVersions: {
        kemfai_dimensions: prepared.installedVersions.kemfai_dimensions,
        kemfai_accounting: prepared.installedVersions.kemfai_accounting,
      },
      companyIds: prepared.companyIds,
      callableModels: ACCOUNTING_FOUNDATION_STORY_THREE_MODELS,
    });
  }
  const browser = await options.startBrowser();
  return { tenants, browser };
}

export type AccountingFoundationOwnedResourceKind =
  | 'database'
  | 'route'
  | 'identity'
  | 'membership'
  | 'company'
  | 'process-group'
  | 'container'
  | 'network'
  | 'volume'
  | 'realm'
  | 'client'
  | 'private-file'
  | 'port';

export interface AccountingFoundationOwnedResource {
  kind: AccountingFoundationOwnedResourceKind;
  id: string;
  ownershipLabel: string;
  created: boolean;
  metadata: Readonly<Record<string, string>>;
}

export interface AccountingFoundationTopologyInput {
  runId: string;
  ownershipLabel: string;
  tenants: ReadonlyArray<{ key: string; tenantId: string }>;
  users: ReadonlyArray<{ key: string; subjectId: string }>;
  memberships: ReadonlyArray<{ membershipId: string; subjectId: string; tenantId: string }>;
  databases: ReadonlyArray<{ key: string; databaseName: string; tenantId: string }>;
  routes: ReadonlyArray<{ routeId: string; tenantId: string; databaseName: string }>;
  companies: ReadonlyArray<{ key: string; companyId: string; tenantId: string }>;
}

type Owned<T> = T & { ownershipLabel: string };

export interface AccountingFoundationOwnershipRegistry {
  runId: string;
  ownershipLabel: string;
  tenants: Array<Owned<{ key: string; tenantId: string }>>;
  users: Array<Owned<{ key: string; subjectId: string }>>;
  memberships: Array<Owned<{ membershipId: string; subjectId: string; tenantId: string }>>;
  databases: Array<Owned<{ key: string; databaseName: string; tenantId: string }>>;
  routes: Array<Owned<{ routeId: string; tenantId: string; databaseName: string }>>;
  companies: Array<Owned<{ key: string; companyId: string; tenantId: string }>>;
}

function requireExactKeys(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${label} topology must contain exactly [${expectedSorted.join(', ')}]`);
  }
}

function requireUnique(values: readonly string[], label: string): void {
  if (values.some((value) => !value.trim())) throw new Error(`${label} cannot be empty`);
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} topology contains a duplicate value`);
  }
}

function stamp<T extends object>(records: readonly T[], ownershipLabel: string): Array<Owned<T>> {
  return records.map((record) => ({ ...record, ownershipLabel }));
}

export function createAccountingFoundationOwnershipRegistry(
  input: AccountingFoundationTopologyInput,
): AccountingFoundationOwnershipRegistry {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,80}$/.test(input.runId)) {
    throw new Error('ownership runId must be a safe non-empty identifier');
  }
  const expectedLabel = `${ACCOUNTING_FOUNDATION_OWNERSHIP_LABEL_PREFIX}${input.runId}`;
  if (input.ownershipLabel !== expectedLabel) {
    throw new Error(`ownership label must equal ${expectedLabel}`);
  }

  requireExactKeys(
    input.tenants.map(({ key }) => key),
    ['tenant-a', 'tenant-b'],
    'tenant',
  );
  requireExactKeys(
    input.users.map(({ key }) => key),
    ['user-a', 'user-b'],
    'user',
  );
  requireExactKeys(
    input.databases.map(({ key }) => key),
    ['tenant-a-db', 'tenant-b-db'],
    'database',
  );
  requireExactKeys(
    input.companies.map(({ key }) => key),
    ['company-a1', 'company-a2', 'company-b1'],
    'company',
  );
  if (input.memberships.length !== 2 || input.routes.length !== 2) {
    throw new Error('topology requires exactly two disjoint memberships and routes');
  }

  requireUnique(
    input.tenants.map(({ tenantId }) => tenantId),
    'tenant id',
  );
  requireUnique(
    input.users.map(({ subjectId }) => subjectId),
    'identity subject',
  );
  requireUnique(
    input.memberships.map(({ membershipId }) => membershipId),
    'membership id',
  );
  requireUnique(
    input.databases.map(({ databaseName }) => databaseName),
    'database name',
  );
  requireUnique(
    input.routes.map(({ routeId }) => routeId),
    'route id',
  );
  requireUnique(
    input.companies.map(({ companyId }) => companyId),
    'company id',
  );

  const tenantByKey = new Map(input.tenants.map((tenant) => [tenant.key, tenant.tenantId]));
  const userByKey = new Map(input.users.map((user) => [user.key, user.subjectId]));
  const databaseByKey = new Map(
    input.databases.map((database) => [database.key, database.databaseName]),
  );
  const expectedMemberships = new Map([
    [userByKey.get('user-a'), tenantByKey.get('tenant-a')],
    [userByKey.get('user-b'), tenantByKey.get('tenant-b')],
  ]);
  for (const membership of input.memberships) {
    if (expectedMemberships.get(membership.subjectId) !== membership.tenantId) {
      throw new Error('membership topology crosses tenant ownership');
    }
  }

  const expectedDatabaseByTenant = new Map([
    [tenantByKey.get('tenant-a'), databaseByKey.get('tenant-a-db')],
    [tenantByKey.get('tenant-b'), databaseByKey.get('tenant-b-db')],
  ]);
  for (const route of input.routes) {
    if (expectedDatabaseByTenant.get(route.tenantId) !== route.databaseName) {
      throw new Error('route topology aliases another tenant database');
    }
  }

  const expectedCompanyTenant = new Map([
    ['company-a1', tenantByKey.get('tenant-a')],
    ['company-a2', tenantByKey.get('tenant-a')],
    ['company-b1', tenantByKey.get('tenant-b')],
  ]);
  for (const company of input.companies) {
    if (expectedCompanyTenant.get(company.key) !== company.tenantId) {
      throw new Error('company topology crosses tenant ownership');
    }
  }

  return {
    runId: input.runId,
    ownershipLabel: input.ownershipLabel,
    tenants: stamp(input.tenants, input.ownershipLabel),
    users: stamp(input.users, input.ownershipLabel),
    memberships: stamp(input.memberships, input.ownershipLabel),
    databases: stamp(input.databases, input.ownershipLabel),
    routes: stamp(input.routes, input.ownershipLabel),
    companies: stamp(input.companies, input.ownershipLabel),
  };
}

export class AccountingFoundationOwnedResourceRegistry {
  private readonly resources = new Map<string, AccountingFoundationOwnedResource>();

  constructor(readonly runId: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,80}$/.test(runId)) {
      throw new Error('ownership runId must be a safe non-empty identifier');
    }
  }

  get ownershipLabel(): string {
    return `${ACCOUNTING_FOUNDATION_OWNERSHIP_LABEL_PREFIX}${this.runId}`;
  }

  register(
    kind: AccountingFoundationOwnedResourceKind,
    id: string,
    metadata: Readonly<Record<string, string>> = {},
  ): AccountingFoundationOwnedResource {
    const normalizedId = id.trim();
    if (!normalizedId) throw new Error(`${kind} id cannot be empty`);
    const key = `${kind}:${normalizedId}`;
    if (this.resources.has(key)) throw new Error(`duplicate owned resource ${key}`);
    const resource: AccountingFoundationOwnedResource = {
      kind,
      id: normalizedId,
      ownershipLabel: this.ownershipLabel,
      created: false,
      metadata: Object.freeze({ ...metadata }),
    };
    this.resources.set(key, resource);
    return resource;
  }

  markCreated(kind: AccountingFoundationOwnedResourceKind, id: string): void {
    const key = `${kind}:${id}`;
    const resource = this.resources.get(key);
    if (!resource) throw new Error(`resource must be registered before creation: ${key}`);
    resource.created = true;
  }

  snapshot(): AccountingFoundationOwnedResource[] {
    return [...this.resources.values()].map((resource) => ({
      ...resource,
      metadata: { ...resource.metadata },
    }));
  }
}

export interface ReservedLoopbackPort {
  name: string;
  host: '127.0.0.1';
  port: number;
  release(): Promise<void>;
}

function listenOnDynamicLoopbackPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
        server.close();
        reject(new Error('dynamic port reservation did not bind IPv4 loopback'));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function reserveDynamicLoopbackPort(name: string): Promise<ReservedLoopbackPort> {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error('invalid listener name');
  const server = createServer();
  const port = await listenOnDynamicLoopbackPort(server);
  let released = false;
  return {
    name,
    host: '127.0.0.1',
    port,
    release: () =>
      new Promise<void>((resolve, reject) => {
        if (released) {
          resolve();
          return;
        }
        released = true;
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export type AccountingFoundationReadinessTargetName =
  | 'control-db'
  | 'redis'
  | 'keycloak'
  | 'odoo'
  | 'nest'
  | 'next'
  | 'tenant-a-route'
  | 'tenant-b-route'
  | 'user-a-session'
  | 'user-b-session';

export interface AccountingFoundationReadinessObservation {
  ready: boolean;
  databaseName?: string;
  installedAddons?: readonly string[];
  companyIds?: readonly string[];
  authenticatedSubjectId?: string;
  detail?: string;
}

export interface AccountingFoundationReadinessTarget {
  name: AccountingFoundationReadinessTargetName;
  probe(): Promise<AccountingFoundationReadinessObservation>;
  expectedDatabaseName?: string;
  requiredAddons?: readonly string[];
  expectedCompanyIds?: readonly string[];
  expectedSubjectId?: string;
}

export interface AccountingFoundationReadinessOptions {
  targets: readonly AccountingFoundationReadinessTarget[];
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface AccountingFoundationReadinessReceipt {
  name: AccountingFoundationReadinessTargetName;
  attempts: number;
  elapsedMs: number;
  observation: AccountingFoundationReadinessObservation;
}

const REQUIRED_READINESS_TARGETS: readonly AccountingFoundationReadinessTargetName[] = [
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
];

function validateReadinessObservation(
  target: AccountingFoundationReadinessTarget,
  observation: AccountingFoundationReadinessObservation,
): boolean {
  if (!observation.ready) return false;
  if (
    target.expectedDatabaseName !== undefined &&
    observation.databaseName !== target.expectedDatabaseName
  ) {
    return false;
  }
  if (
    target.requiredAddons?.some((addon) => !new Set(observation.installedAddons ?? []).has(addon))
  ) {
    return false;
  }
  if (target.expectedCompanyIds) {
    const actual = [...(observation.companyIds ?? [])].sort();
    const expected = [...target.expectedCompanyIds].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  }
  if (
    target.expectedSubjectId !== undefined &&
    observation.authenticatedSubjectId !== target.expectedSubjectId
  ) {
    return false;
  }
  return true;
}

async function probeUntilReady(
  target: AccountingFoundationReadinessTarget,
  options: Required<
    Pick<AccountingFoundationReadinessOptions, 'timeoutMs' | 'intervalMs' | 'now' | 'sleep'>
  >,
): Promise<AccountingFoundationReadinessReceipt> {
  const startedAt = options.now();
  let attempts = 0;
  let lastObservation: AccountingFoundationReadinessObservation = { ready: false };
  while (options.now() - startedAt <= options.timeoutMs) {
    attempts += 1;
    try {
      lastObservation = await target.probe();
      if (validateReadinessObservation(target, lastObservation)) {
        return {
          name: target.name,
          attempts,
          elapsedMs: options.now() - startedAt,
          observation: lastObservation,
        };
      }
    } catch (error) {
      lastObservation = {
        ready: false,
        detail: error instanceof Error ? error.message : 'probe failed',
      };
    }
    if (options.now() - startedAt >= options.timeoutMs) break;
    await options.sleep(options.intervalMs);
  }
  throw new Error(
    `readiness timeout for ${target.name} after ${attempts} attempts: ${lastObservation.detail ?? 'not ready'}`,
  );
}

export async function waitForAccountingFoundationReadiness(
  options: AccountingFoundationReadinessOptions,
): Promise<AccountingFoundationReadinessReceipt[]> {
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 300_000
  ) {
    throw new Error('readiness timeoutMs must be a positive bounded integer <= 300000');
  }
  if (
    !Number.isInteger(options.intervalMs) ||
    options.intervalMs <= 0 ||
    options.intervalMs > options.timeoutMs
  ) {
    throw new Error('readiness intervalMs must be positive and no greater than timeoutMs');
  }
  requireExactKeys(
    options.targets.map(({ name }) => name),
    REQUIRED_READINESS_TARGETS,
    'readiness target',
  );
  requireUnique(
    options.targets.map(({ name }) => name),
    'readiness target',
  );

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  return Promise.all(
    options.targets.map((target) =>
      probeUntilReady(target, {
        timeoutMs: options.timeoutMs,
        intervalMs: options.intervalMs,
        now,
        sleep,
      }),
    ),
  );
}
