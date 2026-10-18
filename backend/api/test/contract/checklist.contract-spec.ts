import { INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { ContractCoverage, OpenApiContractValidator } from '../support/openapi-contract-validator';

describe('Onboarding checklist contract (T078)', () => {
  const path = '/onboarding/checklist';
  const validator = new OpenApiContractValidator();
  const coverage = new ContractCoverage(validator);
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());

  it('registers GET /onboarding/checklist in the real AppModule', () => {
    const document = SwaggerModule.createDocument(app, {
      openapi: '3.0.0',
      info: { title: 'KEMFAI runtime contract probe', version: 'T078' },
    });
    expect(document.paths[path]?.get).toBeDefined();
  });

  it('accepts exactly the five live readiness and activation-gate booleans', () => {
    coverage.record(path, 'get', 200, {
      customerAdded: true,
      bankAdded: false,
      productAdded: true,
      firstInvoiceReady: false,
      gatedOnSubscriptionActivation: true,
    });
    for (const missing of [
      'customerAdded',
      'bankAdded',
      'productAdded',
      'firstInvoiceReady',
      'gatedOnSubscriptionActivation',
    ]) {
      const value: Record<string, boolean> = {
        customerAdded: true,
        bankAdded: false,
        productAdded: true,
        firstInvoiceReady: false,
        gatedOnSubscriptionActivation: true,
      };
      delete value[missing];
      expect(() => validator.assertResponse(path, 'get', 200, value)).toThrow();
    }
    expect(() =>
      validator.assertResponse(path, 'get', 200, {
        customerAdded: false,
        bankAdded: false,
        productAdded: false,
        firstInvoiceReady: false,
        gatedOnSubscriptionActivation: true,
        odooDatabase: 'must-never-escape',
      }),
    ).toThrow();
  });

  it.each([
    [401, { statusCode: 401, message: 'Missing bearer token', error: 'Unauthorized' }],
    [
      403,
      {
        statusCode: 403,
        message: 'Caller does not hold a role required for this endpoint',
        error: 'Forbidden',
      },
    ],
    [404, { statusCode: 404, message: 'This feature is not available', error: 'Not Found' }],
    [
      500,
      {
        statusCode: 500,
        message: 'Checklist readiness returned invalid data',
        error: 'Internal Server Error',
      },
    ],
    [
      502,
      { statusCode: 502, message: 'Checklist is temporarily unavailable', error: 'Bad Gateway' },
    ],
  ])('documents and validates the %i response body', (status, body) => {
    coverage.record(path, 'get', status, body);
  });

  it('covers every documented response', () => coverage.assertFullCoverage(path, 'get'));
});
