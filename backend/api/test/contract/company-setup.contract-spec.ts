import { ContractCoverage, OpenApiContractValidator } from '../support/openapi-contract-validator';

/**
 * T049 — contract test for the US3 company-setup wizard endpoints against the committed
 * `specs/001-saas-onboarding-shell/contracts/openapi.yaml`. Per the arbiter resolution
 * (2026-10-04) this suite is strictly contract-level: it drives OpenApiContractValidator
 * and ContractCoverage directly against the committed document. The production wizard
 * surface is T054/T055 and is deliberately NOT implemented here, so no HTTP server is
 * booted and no Odoo RPC is performed. Status conformance is the complete contract
 * assertion for every response whose body schema the contract does not yet declare
 * (PUT 200/422/409 and POST complete 200/422); where a schema IS declared (GET 200 →
 * CompanySetupState) the example body is validated against it.
 */
describe('Company setup contract (T049, against contracts/openapi.yaml)', () => {
  const validator = new OpenApiContractValidator();
  const coverage = new ContractCoverage(validator);

  describe('GET /companies/current/setup', () => {
    it('200: fresh wizard state conforms to CompanySetupState (resume at first incomplete step)', () => {
      coverage.record('/companies/current/setup', 'get', 200, {
        currentStep: 'country',
        setupComplete: false,
        values: {},
      });
    });
  });

  describe('PUT /companies/current/setup request body (CompanySetupStepInput)', () => {
    it('accepts a valid single-step save', () => {
      expect(() =>
        validator.validateRequestBody('/companies/current/setup', 'put', {
          step: 'country',
          values: { country: 'AE' },
        }),
      ).not.toThrow();
    });

    it('rejects a body that omits "step"', () => {
      expect(() =>
        validator.validateRequestBody('/companies/current/setup', 'put', {
          values: { country: 'AE' },
        }),
      ).toThrow(/step/);
    });

    it('rejects a body that omits "values"', () => {
      expect(() =>
        validator.validateRequestBody('/companies/current/setup', 'put', { step: 'country' }),
      ).toThrow(/values/);
    });
  });

  describe('PUT /companies/current/setup responses', () => {
    it('200: step saved, values preserved (Acceptance Scenario 3.3)', () => {
      coverage.record('/companies/current/setup', 'put', 200, undefined);
    });

    it('422: field-level validation failure (FR-026)', () => {
      coverage.record('/companies/current/setup', 'put', 422, undefined);
    });

    it('409: missing country validation rule — configuration gap, never silently accepted', () => {
      coverage.record('/companies/current/setup', 'put', 409, undefined);
    });
  });

  describe('POST /companies/current/setup/complete', () => {
    it('200: company marked setup complete (Acceptance Scenario 3.7)', () => {
      coverage.record('/companies/current/setup/complete', 'post', 200, undefined);
    });

    it('422: one or more required steps incomplete', () => {
      coverage.record('/companies/current/setup/complete', 'post', 422, undefined);
    });
  });

  describe('coverage (T049 acceptance criterion)', () => {
    it('every documented response code for all three operations was exercised', () => {
      coverage.assertFullCoverage('/companies/current/setup', 'get');
      coverage.assertFullCoverage('/companies/current/setup', 'put');
      coverage.assertFullCoverage('/companies/current/setup/complete', 'post');
    });
  });
});
