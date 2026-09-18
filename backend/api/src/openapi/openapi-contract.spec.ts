import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, relative } from 'path';
import { load as loadYaml } from 'js-yaml';
import {
  committedOpenApiContractPath,
  loadCommittedOpenApiContract,
  OPENAPI_CONTRACT_PATH_ENV,
} from './openapi-contract';

/**
 * T022 unit suite: the loader resolves and parses the COMMITTED contract — the same file
 * later contract tests diff the live spec against — and the committed contract is
 * internally consistent (tags ↔ paths, resolvable $refs, bearerAuth scheme, public paths
 * explicitly opting out of the global bearer security). These properties are what allow
 * setupOpenApi() to guarantee the live BFF conforms with zero drift.
 */

/** Reads the committed contract independently of the loader under test. */
function readCommittedContractJson(): Record<string, unknown> {
  return loadYaml(readFileSync(committedOpenApiContractPath(), 'utf8')) as Record<string, unknown>;
}

/** Recursively walks any JSON value and returns every $ref string found. */
function collectRefs(node: unknown, refs: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((item) => collectRefs(item, refs));
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string') refs.push(value);
      else collectRefs(value, refs);
    }
  }
  return refs;
}

/** Resolves an internal `#/a/b/c` pointer against the document root. */
function resolvePointer(doc: unknown, pointer: string): unknown {
  if (!pointer.startsWith('#/')) return undefined;
  let current: unknown = doc;
  for (const segment of pointer.slice(2).split('/')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

describe('committedOpenApiContractPath (T022)', () => {
  const originalEnv = process.env[OPENAPI_CONTRACT_PATH_ENV];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[OPENAPI_CONTRACT_PATH_ENV];
    else process.env[OPENAPI_CONTRACT_PATH_ENV] = originalEnv;
  });

  it('defaults to the committed contract inside this repository, and that file exists', () => {
    const path = committedOpenApiContractPath();
    expect(
      path.endsWith(join('specs', '001-saas-onboarding-shell', 'contracts', 'openapi.yaml')),
    ).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('honors an absolute OPENAPI_CONTRACT_PATH override', () => {
    const fixture = join(mkdtempSync(join(tmpdir(), 'kemfai-openapi-')), 'contract.yaml');
    const minimalValid = [
      'openapi: 3.0.3',
      'info: {title: Fixture, version: "0.0.0"}',
      'paths: {/ping: {get: {responses: {"200": {description: ok}}}}}',
      'components: {securitySchemes: {bearerAuth: {type: http, scheme: bearer}}}',
      '',
    ].join('\n');
    writeFileSync(fixture, minimalValid);
    try {
      process.env[OPENAPI_CONTRACT_PATH_ENV] = fixture;
      expect(committedOpenApiContractPath()).toBe(fixture);
      expect(loadCommittedOpenApiContract().info.title).toBe('Fixture');
    } finally {
      rmSync(join(fixture, '..'), { recursive: true, force: true });
    }
  });

  it('resolves a relative override against the process cwd', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'kemfai-openapi-'));
    const fixture = join(fixtureDir, 'contract.yaml');
    writeFileSync(
      fixture,
      [
        'openapi: 3.0.3',
        'info: {title: Relative Fixture, version: "0.0.0"}',
        'paths: {/ping: {get: {responses: {"200": {description: ok}}}}}',
        'components: {securitySchemes: {bearerAuth: {type: http, scheme: bearer}}}',
        '',
      ].join('\n'),
    );
    // A cwd-relative path to a real file: proves the override resolves via process.cwd().
    const relativeOverride = relative(process.cwd(), fixture);
    expect(isAbsolute(relativeOverride)).toBe(false);
    process.env[OPENAPI_CONTRACT_PATH_ENV] = relativeOverride;
    try {
      expect(committedOpenApiContractPath()).toBe(fixture);
      expect(loadCommittedOpenApiContract().info.title).toBe('Relative Fixture');
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('fails fast with the attempted path when the contract file is missing', () => {
    process.env[OPENAPI_CONTRACT_PATH_ENV] = join(tmpdir(), 'definitely-not-here-openapi.yaml');
    expect(() => loadCommittedOpenApiContract()).toThrow(
      /OpenAPI contract not found.*definitely-not-here-openapi/,
    );
  });

  it('fails fast when the contract is not valid YAML', () => {
    const fixture = join(mkdtempSync(join(tmpdir(), 'kemfai-openapi-')), 'broken.yaml');
    writeFileSync(fixture, 'openapi: [unbalanced');
    process.env[OPENAPI_CONTRACT_PATH_ENV] = fixture;
    try {
      expect(() => loadCommittedOpenApiContract()).toThrow(/not valid YAML/);
    } finally {
      rmSync(join(fixture, '..'), { recursive: true, force: true });
    }
  });

  it('fails fast when the document is YAML but not a servable OpenAPI 3 contract', () => {
    const fixture = join(mkdtempSync(join(tmpdir(), 'kemfai-openapi-')), 'not-openapi.yaml');
    writeFileSync(fixture, 'openapi: 2.0\ninfo: {title: Old, version: "1"}\npaths: {}\n');
    process.env[OPENAPI_CONTRACT_PATH_ENV] = fixture;
    try {
      expect(() => loadCommittedOpenApiContract()).toThrow(/not servable/);
    } finally {
      rmSync(join(fixture, '..'), { recursive: true, force: true });
    }
  });
});

describe('committed contract internal consistency (T022)', () => {
  const doc = readCommittedContractJson();

  it('is OpenAPI 3 with the expected identity and the 11 contract tags', () => {
    expect(doc.openapi).toBe('3.0.3');
    expect((doc.info as Record<string, unknown>).title).toBe('KEMFAI SaaS Onboarding Shell API');
    expect((doc.info as Record<string, unknown>).version).toBe('0.1.0-slice1');
    expect((doc.tags as Array<{ name: string }>).map((tag) => tag.name)).toEqual([
      'plans',
      'accounts',
      'tenants',
      'company-setup',
      'modules',
      'entitlements',
      'billing-customer',
      'billing-admin',
      'checklist',
      'support-access',
      'audit',
    ]);
  });

  it('declares the bearerAuth security scheme and applies it globally', () => {
    const bearerAuth = (
      (doc.components as Record<string, unknown>).securitySchemes as Record<
        string,
        Record<string, unknown>
      >
    ).bearerAuth;
    expect(bearerAuth.type).toBe('http');
    expect(bearerAuth.scheme).toBe('bearer');
    expect(bearerAuth.bearerFormat).toBe('JWT');
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it('declares every path under a declared tag, and every declared tag is used by some path', () => {
    const declaredTags = new Set((doc.tags as Array<{ name: string }>).map((tag) => tag.name));
    const usedTags = new Set<string>();
    for (const pathItem of Object.values(doc.paths as Record<string, Record<string, unknown>>)) {
      for (const operation of Object.values(pathItem)) {
        if (operation === null || typeof operation !== 'object') continue;
        const tags = (operation as Record<string, unknown>).tags as string[] | undefined;
        expect(tags && tags.length).toBeTruthy();
        for (const tag of tags ?? []) {
          expect(declaredTags.has(tag)).toBe(true);
          usedTags.add(tag);
        }
      }
    }
    expect([...declaredTags].sort()).toEqual([...usedTags].sort());
  });

  it('has only internally resolvable $refs (no schema reference can 404 inside the live spec)', () => {
    const refs = collectRefs(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/')).toBe(true);
      expect(resolvePointer(doc, ref)).toBeDefined();
    }
  });

  it('explicitly opts the pre-authentication surfaces out of the global bearer security', () => {
    const paths = doc.paths as Record<string, Record<string, { security?: unknown[] }>>;
    for (const publicPath of [
      '/public/plans',
      '/accounts/signup',
      '/accounts/verify-email',
      '/accounts/resend-verification',
    ]) {
      expect(paths[publicPath]).toBeDefined();
      for (const operation of Object.values(paths[publicPath])) {
        if (operation === null || typeof operation !== 'object') continue;
        expect((operation as { security?: unknown[] }).security).toEqual([]);
      }
    }
  });
});
