import { ContractCoverage, OpenApiContractValidator } from '../support/openapi-contract-validator';

/**
 * T055 (FR-028, F3 remediation / T105 scope) — contract test for the post-completion
 * `GET`/`PUT /companies/current/settings` surface against the committed
 * `specs/001-saas-onboarding-shell/contracts/openapi.yaml`, mirroring
 * `company-setup.contract-spec.ts`'s style: strictly contract-level, no HTTP server or
 * Odoo RPC. The real-Odoo/live-HTTP proof — including the pre-completion 409 case with
 * the actual `CompanySetupIncompleteError` body `CompanySettingsService` returns — lives
 * in `test/integration/company-setup-live.integration-spec.ts`. Every documented status
 * code on this path (200/403/409 for GET, 200/403/409 for PUT) is exercised here with a
 * body conforming to its declared schema, per T105's acceptance criterion that the 409
 * case specifically match `CompanySetupIncompleteError` exactly.
 */
describe('Company settings contract (T055/T105, against contracts/openapi.yaml)', () => {
  const path = '/companies/current/settings';
  const methods = ['get', 'put'] as const;
  const setupIncompleteBody = {
    statusCode: 409,
    message: 'settings are not reachable until setup is complete.',
    setupComplete: false,
  };
  const validator = new OpenApiContractValidator();
  const coverage = new ContractCoverage(validator);

  describe('GET /companies/current/settings', () => {
    it('200: conforms to CompanySettingsView', () => {
      coverage.record('/companies/current/settings', 'get', 200, {
        values: { country: 'AE', legal_name: 'Acme FZ' },
        setupComplete: true,
      });
    });

    it('403: caller is not the Workspace Owner for this tenant', () => {
      coverage.record(path, 'get', 403, undefined);
    });

    it('409: setup not yet complete conforms exactly to CompanySetupIncompleteError', () => {
      coverage.record(path, 'get', 409, setupIncompleteBody);
    });
  });

  describe('PUT /companies/current/settings request body (CompanySettingsInput)', () => {
    it('accepts a values object', () => {
      expect(() =>
        validator.validateRequestBody('/companies/current/settings', 'put', {
          values: { legal_name: 'Acme Holdings' },
        }),
      ).not.toThrow();
    });

    it('rejects a body that omits "values"', () => {
      expect(() => validator.validateRequestBody('/companies/current/settings', 'put', {})).toThrow(
        /values/,
      );
    });
  });

  describe('PUT /companies/current/settings responses', () => {
    it('200: settings updated using the documented status', () => {
      coverage.record(path, 'put', 200, {
        values: { legal_name: 'Acme Holdings' },
        setupComplete: true,
      });
    });

    it('403: caller is not the Workspace Owner for this tenant', () => {
      coverage.record(path, 'put', 403, undefined);
    });

    it('409: setup not yet complete conforms exactly to CompanySetupIncompleteError', () => {
      coverage.record(path, 'put', 409, setupIncompleteBody);
    });
  });

  describe('canonical pre-completion 409 regression controls', () => {
    it.each(methods)('%s binds 409 directly to CompanySetupIncompleteError', (method) => {
      expect(validator.responseSchema(path, method, 409)).toEqual({
        $ref: '#/components/schemas/CompanySetupIncompleteError',
      });
    });

    it.each(methods)('%s rejects a different pre-completion status', (method) => {
      expect(() => validator.assertResponse(path, method, 410, setupIncompleteBody)).toThrow(
        /undocumented status 410/,
      );
    });

    it.each([
      ['missing setupComplete', { statusCode: 409, message: 'setup incomplete' }],
      [
        'wrong statusCode in the body',
        { statusCode: 403, message: 'setup incomplete', setupComplete: false },
      ],
      ['setupComplete=true', { statusCode: 409, message: 'setup incomplete', setupComplete: true }],
      [
        'non-string message',
        { statusCode: 409, message: ['setup incomplete'], setupComplete: false },
      ],
    ])('rejects the wrong error shape: %s', (_caseName, body) => {
      for (const method of methods) {
        expect(() => validator.assertResponse(path, method, 409, body)).toThrow(
          /does not match its declared schema/,
        );
      }
    });
  });

  describe('coverage (T105 acceptance criterion)', () => {
    it('every documented response code for both operations was exercised', () => {
      coverage.assertFullCoverage(path, 'get');
      coverage.assertFullCoverage(path, 'put');
    });
  });
});
