import { readFileSync } from 'node:fs';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import { resolve } from 'node:path';
import { load } from 'js-yaml';

type JsonObject = Record<string, unknown>;

const CONTRACT_PATH = resolve(
  __dirname,
  '../../../../specs/003-accounting-foundation/contracts/openapi.yaml',
);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
const CANONICAL_OPERATIONS = [
  'GET /capabilities',
  'GET /accounts',
  'POST /accounts',
  'GET /accounts/{accountId}',
  'PATCH /accounts/{accountId}',
  'GET /dimension-definitions',
  'POST /dimension-definitions',
  'PATCH /dimension-definitions/{definitionId}',
  'GET /dimension-values',
  'POST /dimension-values',
  'PATCH /dimension-values/{valueId}',
  'GET /dimension-rules',
  'POST /dimension-rules',
  'PATCH /dimension-rules/{ruleId}',
  'GET /journals',
  'POST /journals',
  'PATCH /journals/{journalId}',
  'GET /currencies',
  'PUT /currencies/{currencyCode}',
  'GET /drafts',
  'POST /drafts',
  'GET /drafts/{draftId}',
  'PUT /drafts/{draftId}',
  'POST /drafts/{draftId}/validate',
].sort();

const STORY_ONE_RUNTIME_OPERATIONS = [
  'GET /capabilities',
  'GET /accounts',
  'POST /accounts',
  'GET /accounts/{accountId}',
  'PATCH /accounts/{accountId}',
  'POST /drafts',
  'GET /drafts/{draftId}',
  'POST /drafts/{draftId}/validate',
].sort();

const STORY_TWO_RUNTIME_OPERATIONS = [
  'GET /dimension-definitions',
  'POST /dimension-definitions',
  'PATCH /dimension-definitions/{definitionId}',
  'GET /dimension-values',
  'POST /dimension-values',
  'PATCH /dimension-values/{valueId}',
  'GET /dimension-rules',
  'POST /dimension-rules',
  'PATCH /dimension-rules/{ruleId}',
].sort();

const STORY_THREE_RUNTIME_OPERATIONS = [
  'GET /journals',
  'POST /journals',
  'PATCH /journals/{journalId}',
  'GET /currencies',
  'PUT /currencies/{currencyCode}',
  'GET /drafts',
  'POST /drafts',
  'GET /drafts/{draftId}',
  'PUT /drafts/{draftId}',
  'POST /drafts/{draftId}/validate',
].sort();

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveLocalRef(document: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) {
    throw new Error(`Accounting contract must not use an external $ref: ${ref}`);
  }

  return ref
    .slice(2)
    .split('/')
    .map(decodePointerToken)
    .reduce<unknown>((current, token) => {
      if (!current || typeof current !== 'object' || !(token in current)) {
        throw new Error(`Unresolved local $ref ${ref} at token ${token}`);
      }
      return (current as JsonObject)[token];
    }, document);
}

function collectRefs(node: unknown, refs: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((value) => collectRefs(value, refs));
    return refs;
  }
  if (!node || typeof node !== 'object') return refs;

  for (const [key, value] of Object.entries(node as JsonObject)) {
    if (key === '$ref' && typeof value === 'string') refs.push(value);
    collectRefs(value, refs);
  }
  return refs;
}

function operationMatrix(document: JsonObject): string[] {
  const paths = document.paths as JsonObject | undefined;
  if (!paths) throw new Error('Accounting contract has no paths object');

  return Object.entries(paths)
    .flatMap(([path, item]) =>
      Object.keys(item as JsonObject)
        .filter((method) => HTTP_METHODS.has(method.toLowerCase()))
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

describe('Accounting Foundation committed OpenAPI contract (T001)', () => {
  let document: JsonObject;

  beforeAll(() => {
    document = load(readFileSync(CONTRACT_PATH, 'utf8')) as JsonObject;
  });

  it('loads as an OpenAPI 3 document with paths and components', () => {
    expect(document.openapi).toMatch(/^3\./);
    expect(document.info).toEqual(expect.objectContaining({ title: expect.any(String) }));
    expect(document.paths).toBeDefined();
    expect(document.components).toBeDefined();
  });

  it('resolves every local reference and rejects external references', () => {
    const refs = collectRefs(document);
    expect(refs.length).toBeGreaterThan(0);

    for (const ref of refs) {
      expect(() => resolveLocalRef(document, ref)).not.toThrow();
    }
  });

  it('matches the canonical safe path/method matrix exactly', () => {
    expect(operationMatrix(document)).toEqual(CANONICAL_OPERATIONS);
  });
});

describe('Accounting Foundation OpenAPI/runtime parity (T026)', () => {
  const document = load(readFileSync(CONTRACT_PATH, 'utf8')) as JsonObject;
  const paths = document.paths as Record<string, Record<string, JsonObject>>;
  const components = document.components as JsonObject;
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires company/correlation/locale and mutation concurrency/idempotency headers', () => {
    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;
        const refs = (operation.parameters as JsonObject[] | undefined)?.map(
          (parameter) => parameter.$ref,
        );
        expect(refs).toEqual(
          expect.arrayContaining([
            '#/components/parameters/CompanyId',
            '#/components/parameters/AcceptLanguage',
            '#/components/parameters/CorrelationId',
          ]),
        );
        if (['post', 'put', 'patch'].includes(method)) {
          expect(refs).toContain('#/components/parameters/IdempotencyKey');
        }
        if (method === 'patch' || method === 'put' || path.endsWith('/validate')) {
          expect(refs).toEqual(
            expect.arrayContaining([expect.stringMatching(/#\/components\/parameters\/IfMatch/)]),
          );
        }
      }
    }
  });

  it('declares auth/permission plus conflict/precondition/validation/outage status parity', () => {
    for (const pathItem of Object.values(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;
        const statuses = new Set(Object.keys(operation.responses as JsonObject));
        expect(statuses.has('401')).toBe(true);
        expect(statuses.has('403')).toBe(true);
        if (['post', 'put', 'patch'].includes(method)) {
          expect(statuses.has('409')).toBe(true);
          expect(statuses.has('422')).toBe(true);
          expect(statuses.has('503')).toBe(true);
        }
        if (
          method === 'patch' ||
          method === 'put' ||
          pathItem === paths['/drafts/{draftId}/validate']
        ) {
          expect(statuses.has('412')).toBe(true);
        }
      }
    }
  });

  it('binds mutation results to receipt and ETag schemas without private identifiers', () => {
    const schemas = components.schemas as Record<string, JsonObject>;
    const accountResult = schemas.MutationAccountResult;
    const genericResult = schemas.ValidationMutationResult;
    expect(JSON.stringify(accountResult)).toContain('#/components/schemas/MutationReceipt');
    expect(JSON.stringify(genericResult)).toContain('#/components/schemas/MutationReceipt');
    const serialized = JSON.stringify({ paths, schemas });
    for (const forbidden of ['odooDbName', 'odoo_db_name', 'odooCompanyId', 'odoo_company_id']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('keeps every posting-level capability constrained to the literal false value', () => {
    const schemas = components.schemas as Record<string, JsonObject>;
    const capabilityText = JSON.stringify(schemas.AccountingCapabilities);
    for (const flag of [
      'postingEnabled',
      'reversalEnabled',
      'openingPostingEnabled',
      'periodEnforcementEnabled',
    ]) {
      expect(capabilityText).toContain(flag);
    }
    const capabilities = schemas.AccountingCapabilities.properties as Record<string, JsonObject>;
    for (const flag of [
      'postingEnabled',
      'reversalEnabled',
      'openingPostingEnabled',
      'periodEnforcementEnabled',
    ]) {
      expect(capabilities[flag].enum).toEqual([false]);
    }
  });

  it.each(STORY_ONE_RUNTIME_OPERATIONS)(
    'mounts %s behind authentication instead of exposing 404 or a native surface',
    async (operation) => {
      const [method, templatedPath] = operation.split(' ');
      const concretePath = templatedPath
        .replace('{accountId}', '11111111-1111-4111-8111-111111111111')
        .replace('{definitionId}', '22222222-2222-4222-8222-222222222222')
        .replace('{valueId}', '33333333-3333-4333-8333-333333333333')
        .replace('{ruleId}', '44444444-4444-4444-8444-444444444444')
        .replace('{journalId}', '55555555-5555-4555-8555-555555555555')
        .replace('{currencyCode}', 'AED')
        .replace('{draftId}', '66666666-6666-4666-8666-666666666666');
      const response = await request(app.getHttpServer())
        [method.toLowerCase() as 'get'](`/v1/accounting${concretePath}`)
        .send({});
      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toMatch(/odoo|res\.|account\.account/i);
    },
  );
});

describe('Accounting Foundation Story 2 contract/runtime parity (T076)', () => {
  const document = load(readFileSync(CONTRACT_PATH, 'utf8')) as JsonObject;
  const paths = document.paths as Record<string, Record<string, JsonObject>>;
  const schemas = (document.components as JsonObject).schemas as Record<string, JsonObject>;
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('defines scoped versioned dimension, value, and rule resources with exact requirements', () => {
    expect(JSON.stringify(schemas.DimensionDefinition)).toContain(
      '#/components/schemas/VersionedResource',
    );
    expect(JSON.stringify(schemas.DimensionValue)).toContain(
      '#/components/schemas/VersionedResource',
    );
    expect(JSON.stringify(schemas.DimensionRule)).toContain(
      '#/components/schemas/VersionedResource',
    );
    expect((schemas.DimensionKind.enum as string[]).sort()).toEqual(['built_in', 'custom', 'tag']);
    expect((schemas.DimensionRequirement.enum as string[]).sort()).toEqual([
      'optional',
      'prohibited',
      'required',
    ]);
    expect(schemas.DimensionRuleCreate.required).toEqual(['dimensionDefinitionId', 'requirement']);
    expect(schemas.DimensionRuleCreate.anyOf).toEqual([
      { required: ['accountId'] },
      { required: ['transactionType'] },
    ]);
  });

  it('binds every dimension mutation to idempotency, ETag concurrency, receipts, and fail-closed statuses', () => {
    for (const operation of STORY_TWO_RUNTIME_OPERATIONS.filter(
      (item) => !item.startsWith('GET'),
    )) {
      const [method, path] = operation.split(' ');
      const definition = paths[path][method.toLowerCase()];
      const parameters = definition.parameters as JsonObject[];
      const refs = parameters.map((parameter) => parameter.$ref);
      expect(refs).toContain('#/components/parameters/IdempotencyKey');
      if (method === 'PATCH') {
        expect(refs).toContain('#/components/parameters/IfMatch');
      }
      expect(Object.keys(definition.responses as JsonObject)).toEqual(
        expect.arrayContaining(['401', '403', '409', '422', '503']),
      );
      if (method === 'PATCH') {
        expect(Object.keys(definition.responses as JsonObject)).toContain('412');
      }
      const success = (definition.responses as Record<string, JsonObject>)[
        method === 'POST' ? '201' : '200'
      ];
      expect(JSON.stringify(success)).toContain('#/components/schemas/MutationReceipt');
      expect(JSON.stringify(success)).toContain('#/components/headers/ETag');
    }
  });

  it('requires normalized draft assignments, stable dimension errors, snapshots, and literal no-ledger effect', () => {
    expect(schemas.DimensionAssignmentWrite.required).toEqual(['definitionId', 'valueId']);
    expect(JSON.stringify(schemas.DraftLineWrite)).toContain(
      '#/components/schemas/DimensionAssignmentWrite',
    );
    const issueCodes = ((schemas.ValidationIssue.properties as Record<string, JsonObject>).code
      .enum ?? []) as string[];
    expect(issueCodes).toEqual(
      expect.arrayContaining([
        'DIMENSION_REQUIRED',
        'DIMENSION_PROHIBITED',
        'DIMENSION_INACTIVE',
        'DIMENSION_OUT_OF_SCOPE',
      ]),
    );
    expect(JSON.stringify(schemas.ConfigurationSnapshot)).toContain('dimensionRules');
    expect(schemas.NoLedgerEffect.enum).toEqual(['none']);
    expect(JSON.stringify(schemas.ValidationMutationResult)).toContain(
      '#/components/schemas/MutationReceipt',
    );
  });

  it.each(STORY_TWO_RUNTIME_OPERATIONS)(
    'mounts %s behind authentication instead of returning 404 or exposing a native surface',
    async (operation) => {
      const [method, templatedPath] = operation.split(' ');
      const concretePath = templatedPath
        .replace('{definitionId}', '22222222-2222-4222-8222-222222222222')
        .replace('{valueId}', '33333333-3333-4333-8333-333333333333')
        .replace('{ruleId}', '44444444-4444-4444-8444-444444444444');
      const response = await request(app.getHttpServer())
        [method.toLowerCase() as 'get'](`/v1/accounting${concretePath}`)
        .send({});
      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toMatch(/odoo|kemfai\.dimension|res\.|database/i);
    },
  );
});

describe('Accounting Foundation Story 3 full contract/runtime parity (T111)', () => {
  const document = load(readFileSync(CONTRACT_PATH, 'utf8')) as JsonObject;
  const paths = document.paths as Record<string, Record<string, JsonObject>>;
  const schemas = (document.components as JsonObject).schemas as Record<string, JsonObject>;
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps exact decimal lexemes, immutable native metadata, and conditional FX provenance in the public schemas', () => {
    expect(schemas.DecimalAmount).toEqual(
      expect.objectContaining({
        type: 'string',
        pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$',
      }),
    );
    const currency = schemas.CurrencyConfiguration.properties as Record<string, JsonObject>;
    for (const field of [
      'currencyCode',
      'nativeDecimalPlaces',
      'nativeMetadataVersion',
      'isBase',
    ]) {
      expect(currency[field].readOnly).toBe(true);
    }
    const draftLine = schemas.DraftLineWrite;
    expect(draftLine.required).toEqual(
      expect.arrayContaining([
        'transactionCurrencyMetadataVersion',
        'baseCurrencyMetadataVersion',
        'currencyConfigurationVersion',
        'transactionDebit',
        'transactionCredit',
        'baseDebit',
        'baseCredit',
        'rateReference',
        'rateEffectiveDate',
      ]),
    );
    expect(draftLine.oneOf).toHaveLength(2);
    expect(JSON.stringify(draftLine)).not.toMatch(/number|multipleOf/);
  });

  it('requires receipt, ETag, recovery statuses, immutable validation evidence, and literal no-ledger results', () => {
    for (const operation of STORY_THREE_RUNTIME_OPERATIONS.filter(
      (item) => !item.startsWith('GET'),
    )) {
      const [method, path] = operation.split(' ');
      const definition = paths[path][method.toLowerCase()];
      const refs = (definition.parameters as JsonObject[]).map((parameter) => parameter.$ref);
      expect(refs).toContain('#/components/parameters/IdempotencyKey');
      if (method === 'PATCH' || method === 'PUT' || path.endsWith('/validate')) {
        expect(refs).toEqual(expect.arrayContaining([expect.stringMatching(/IfMatch/)]));
      }
      expect(Object.keys(definition.responses as JsonObject)).toEqual(
        expect.arrayContaining(['409', '422', '503']),
      );
      const responseRefs = collectRefs(definition.responses);
      expect(
        responseRefs.some(
          (ref) =>
            ref === '#/components/schemas/MutationReceipt' ||
            JSON.stringify(resolveLocalRef(document, ref)).includes(
              '#/components/schemas/MutationReceipt',
            ),
        ),
      ).toBe(true);
    }
    expect(schemas.NoLedgerEffect.enum).toEqual(['none']);
    expect(schemas.ValidationStatus.enum).toEqual(['valid_for_draft', 'invalid']);
    expect(schemas.DraftValidationResult.required).toEqual(
      expect.arrayContaining([
        'id',
        'draftId',
        'draftVersion',
        'configurationSnapshot',
        'baseDebitTotal',
        'baseCreditTotal',
        'ledgerEffect',
      ]),
    );
    expect(JSON.stringify(schemas.DraftValidationResult)).not.toContain('valid_for_post');
  });

  it.each(STORY_THREE_RUNTIME_OPERATIONS)(
    'mounts %s behind authentication instead of returning 404 or exposing a native surface',
    async (operation) => {
      const [method, templatedPath] = operation.split(' ');
      const concretePath = templatedPath
        .replace('{journalId}', '55555555-5555-4555-8555-555555555555')
        .replace('{currencyCode}', 'AED')
        .replace('{draftId}', '66666666-6666-4666-8666-666666666666');
      const response = await request(app.getHttpServer())
        [method.toLowerCase() as 'get'](`/v1/accounting${concretePath}`)
        .send({});
      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toMatch(
        /odoo|account\.journal|account\.move|res\.currency|database/i,
      );
    },
  );
});

describe('Accounting Foundation forbidden runtime surfaces (T002)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['post', '/v1/accounting/drafts/11111111-1111-4111-8111-111111111111/post'],
    ['post', '/v1/accounting/entries/11111111-1111-4111-8111-111111111111/reverse'],
    ['post', '/v1/accounting/opening-balances/11111111-1111-4111-8111-111111111111/post'],
    ['post', '/v1/accounting/drafts/11111111-1111-4111-8111-111111111111/approve'],
    ['post', '/v1/accounting/periods/11111111-1111-4111-8111-111111111111/transition'],
  ])('keeps %s %s unmounted', async (method, path) => {
    const response = await request(app.getHttpServer())[method as 'post'](path).send({});
    expect(response.status).toBe(404);
  });
});
