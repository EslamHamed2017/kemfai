import { INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { ContractCoverage, OpenApiContractValidator } from '../support/openapi-contract-validator';

/**
 * T072 — contract tests for the US4 module-selection surface.
 *
 * T075/T076 own the Odoo cache and the HTTP implementation. Until T076 lands, this suite
 * deliberately remains RED: constructing the real AppModule and deriving its Swagger
 * document makes route registration a load-bearing assertion without inventing a test-only
 * controller. The schema examples below exercise the committed 200/403 contract independently;
 * they are synthetic contract fixtures, not claims about PostgreSQL, Redis, Odoo, or live HTTP.
 *
 * Once T076 registers the routes, its controller must use the existing global guard chain
 * (including FeatureFlagGuard and TrialWindowGuard) and EntitlementsService. Their behavioural
 * HTTP coverage belongs with T073/T076; this contract suite neither replaces nor bypasses it.
 */
describe('Modules contract (T072, against contracts/openapi.yaml)', () => {
  const modulesPath = '/modules';
  const selectionPath = '/modules/selection';
  const validator = new OpenApiContractValidator();
  const coverage = new ContractCoverage(validator);

  describe('actual application routes', () => {
    let app: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('registers GET /modules and PUT /modules/selection in the actual application', () => {
      const runtimeDocument = SwaggerModule.createDocument(app, {
        openapi: '3.0.0',
        info: { title: 'KEMFAI runtime contract probe', version: 'T072' },
      });

      expect(runtimeDocument.paths[modulesPath]?.get).toBeDefined();
      expect(runtimeDocument.paths[selectionPath]?.put).toBeDefined();
    });
  });

  it('GET /modules 200: plan inclusion and upgrade indicators are schema-conformant', () => {
    coverage.record(modulesPath, 'get', 200, [
      {
        key: 'module.accounting',
        name: 'Accounting',
        includedInCurrentPlan: true,
        requiredPlanTier: null,
      },
      {
        key: 'module.inventory',
        name: 'Inventory',
        includedInCurrentPlan: false,
        requiredPlanTier: 'Growth',
      },
    ]);
  });

  it('PUT /modules/selection accepts the documented request shape', () => {
    expect(() =>
      validator.validateRequestBody(selectionPath, 'put', {
        featureKeys: ['module.accounting'],
      }),
    ).not.toThrow();
  });

  it('PUT /modules/selection 200: entitled selection saved', () => {
    coverage.record(selectionPath, 'put', 200, { featureKeys: ['module.accounting'] });
  });

  it('PUT /modules/selection 403: non-entitled selection denied', () => {
    coverage.record(selectionPath, 'put', 403, {
      message: 'One or more selected modules require a different plan',
      featureKeys: ['module.inventory'],
    });
  });

  it('PUT /modules/selection 403: shared guard denial is schema-conformant', () => {
    validator.assertResponse(selectionPath, 'put', 403, {
      statusCode: 403,
      message: 'Forbidden resource',
      error: 'Forbidden',
    });
  });

  it.each([
    ['missing featureKeys', {}],
    ['non-array featureKeys', { featureKeys: 'module.accounting' }],
    ['non-string feature key', { featureKeys: [7] }],
  ])('PUT /modules/selection 200 rejects %s', (_label, body) => {
    expect(() => validator.assertResponse(selectionPath, 'put', 200, body)).toThrow();
  });

  it.each([
    ['entitlement denial missing featureKeys', { message: 'not entitled' }],
    ['entitlement denial missing message', { featureKeys: ['module.inventory'] }],
    ['guard denial missing statusCode', { message: 'Forbidden', error: 'Forbidden' }],
  ])('PUT /modules/selection 403 rejects %s', (_label, body) => {
    expect(() => validator.assertResponse(selectionPath, 'put', 403, body)).toThrow();
  });

  it('exercises every documented response code for both operations', () => {
    coverage.assertFullCoverage(modulesPath, 'get');
    coverage.assertFullCoverage(selectionPath, 'put');
  });
});
