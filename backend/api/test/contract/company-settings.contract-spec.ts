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
      coverage.record('/companies/current/settings', 'get', 403, undefined);
    });

    it('409: setup not yet complete conforms exactly to CompanySetupIncompleteError', () => {
      coverage.record('/companies/current/settings', 'get', 409, {
        statusCode: 409,
        message: 'settings are not reachable until setup is complete.',
        setupComplete: false,
      });
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
    it('200: settings updated, conforms to CompanySettingsView', () => {
      coverage.record('/companies/current/settings', 'put', 200, {
        values: { legal_name: 'Acme Holdings' },
        setupComplete: true,
      });
    });

    it('403: caller is not the Workspace Owner for this tenant', () => {
      coverage.record('/companies/current/settings', 'put', 403, undefined);
    });

    it('409: setup not yet complete conforms exactly to CompanySetupIncompleteError', () => {
      coverage.record('/companies/current/settings', 'put', 409, {
        statusCode: 409,
        message: 'settings are not reachable until setup is complete.',
        setupComplete: false,
      });
    });
  });

  describe('coverage (T105 acceptance criterion)', () => {
    it('every documented response code for both operations was exercised', () => {
      coverage.assertFullCoverage('/companies/current/settings', 'get');
      coverage.assertFullCoverage('/companies/current/settings', 'put');
    });
  });
});
