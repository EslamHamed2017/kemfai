import { ContractCoverage, OpenApiContractValidator } from '../support/openapi-contract-validator';

/**
 * T070 contract test for the internal Billing Admin decision surface against the
 * committed specs/001-saas-onboarding-shell/contracts/openapi.yaml (reviewer finding 4:
 * the YAML, the generated frontend client, and the contract tests must agree on the
 * decision results, the 404/409/422 responses, and the nonblank/4000-character notes
 * restrictions the request DTOs enforce).
 *
 * Contract-level by design: the live HTTP behavior of these routes is proven by the
 * T064/T070 integration suites against the production AppModule; this suite pins the
 * committed contract's declared shapes so the generated client (openapi-typescript over
 * this same file) can never drift back to `content?: never`.
 */
describe('Billing admin decision contract (T070, against contracts/openapi.yaml)', () => {
  const rejectPath = '/internal/billing/payment-submissions/{submissionId}/reject';
  const moreInfoPath = '/internal/billing/payment-submissions/{submissionId}/request-more-info';
  const approvePath = '/internal/billing/payment-submissions/{submissionId}/approve';
  const validator = new OpenApiContractValidator();
  const coverage = new ContractCoverage(validator);

  describe(`POST ${rejectPath}`, () => {
    it('200: the rejected decision conforms to BillingDecisionResult', () => {
      coverage.record(rejectPath, 'post', 200, {
        submissionId: '07000000-0000-4000-8000-000000000001',
        status: 'Rejected',
        decision: 'reject',
        decisionNotes: 'The transferred amount does not match the amount due.',
        decidedAt: '2026-10-14T08:00:00.000Z',
      });
    });

    it('404/409/422: exercises every documented failure status', () => {
      for (const status of [404, 409, 422] as const) {
        coverage.record(rejectPath, 'post', status, undefined);
      }
    });

    it('accepts a valid mandatory reason', () => {
      expect(() =>
        validator.validateRequestBody(rejectPath, 'post', {
          reason: 'Amount mismatch for this period.',
        }),
      ).not.toThrow();
    });

    it('rejects a missing, empty, or blank reason', () => {
      expect(() => validator.validateRequestBody(rejectPath, 'post', {})).toThrow(/reason/);
      expect(() => validator.validateRequestBody(rejectPath, 'post', { reason: '' })).toThrow(
        /reason/,
      );
      expect(() => validator.validateRequestBody(rejectPath, 'post', { reason: '   ' })).toThrow(
        /reason/,
      );
    });

    it('rejects a reason longer than the 4000-character DTO bound', () => {
      expect(() =>
        validator.validateRequestBody(rejectPath, 'post', { reason: 'a'.repeat(4001) }),
      ).toThrow(/reason/);
      expect(() =>
        validator.validateRequestBody(rejectPath, 'post', { reason: 'a'.repeat(4000) }),
      ).not.toThrow();
    });
  });

  describe(`POST ${moreInfoPath}`, () => {
    it('200: the more-info decision conforms to BillingDecisionResult', () => {
      coverage.record(moreInfoPath, 'post', 200, {
        submissionId: '07000000-0000-4000-8000-000000000002',
        status: 'MoreInfoRequested',
        decision: 'more_info',
        decisionNotes: 'Please provide the bank confirmation number.',
        decidedAt: '2026-10-14T08:00:00.000Z',
      });
    });

    it('404/409/422: exercises every documented failure status', () => {
      for (const status of [404, 409, 422] as const) {
        coverage.record(moreInfoPath, 'post', status, undefined);
      }
    });

    it('accepts a valid mandatory details value and rejects missing/blank/oversized ones', () => {
      expect(() =>
        validator.validateRequestBody(moreInfoPath, 'post', {
          details: 'Please provide the transfer receipt.',
        }),
      ).not.toThrow();
      expect(() => validator.validateRequestBody(moreInfoPath, 'post', {})).toThrow(/details/);
      expect(() => validator.validateRequestBody(moreInfoPath, 'post', { details: ' ' })).toThrow(
        /details/,
      );
      expect(() =>
        validator.validateRequestBody(moreInfoPath, 'post', { details: 'a'.repeat(4001) }),
      ).toThrow(/details/);
    });
  });

  describe(`POST ${approvePath}`, () => {
    it('200: the approval conforms to BillingApprovalResult', () => {
      coverage.record(approvePath, 'post', 200, {
        submissionId: '07000000-0000-4000-8000-000000000003',
        subscriptionId: '07000000-0000-4000-8000-000000000004',
        status: 'Active',
        billingPeriodStart: '2026-10-01',
        billingPeriodEnd: '2026-10-31',
        activatedAt: '2026-10-14T08:00:00.000Z',
      });
    });

    it('404/409: exercises every documented failure status', () => {
      for (const status of [404, 409] as const) {
        coverage.record(approvePath, 'post', status, undefined);
      }
    });
  });

  describe('coverage (T027 acceptance criterion)', () => {
    it('exercises every documented response code for all three decision operations', () => {
      coverage.assertFullCoverage(rejectPath, 'post');
      coverage.assertFullCoverage(moreInfoPath, 'post');
      coverage.assertFullCoverage(approvePath, 'post');
    });
  });

  describe('generated client agreement (reviewer finding 4)', () => {
    it('declares a JSON schema for every decision success response', () => {
      for (const [path, status] of [
        [rejectPath, 200],
        [moreInfoPath, 200],
        [approvePath, 200],
      ] as const) {
        expect(validator.responseSchema(path, 'post', status)).toBeDefined();
      }
    });
  });
});
