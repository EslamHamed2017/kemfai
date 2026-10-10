import { ContractCoverage, OpenApiContractValidator } from '../support/openapi-contract-validator';

/**
 * T057 — contract test for the US5 customer billing surface against the committed
 * `specs/001-saas-onboarding-shell/contracts/openapi.yaml`.
 *
 * This suite is intentionally contract-level. T061/T062 own the live controller/service
 * implementation, so this task must not substitute a mocked HTTP application and describe
 * it as live behavior. Response bodies are schema-validated where the committed contract
 * declares a schema (both GET 200 responses). POST 201/409/422 currently declare status and
 * description only, so status conformance is the complete response assertion for those
 * cases. The multipart request itself is validated against PaymentSubmissionInput.
 */
describe('Billing customer contract (T057, against contracts/openapi.yaml)', () => {
  const subscriptionPath = '/billing/subscription';
  const submissionsPath = '/billing/payment-submissions';
  const validator = new OpenApiContractValidator();
  const coverage = new ContractCoverage(validator);

  describe('GET /billing/subscription', () => {
    it('200: awaiting-payment details conform to SubscriptionView', () => {
      coverage.record(subscriptionPath, 'get', 200, {
        status: 'PendingActivation',
        billingPeriodStart: '2026-10-01',
        billingPeriodEnd: '2026-10-31',
        amountDue: 1250.5,
        currency: 'AED',
        bankInstructions: 'T057 private fixture bank instructions',
        paymentReference: 'T057-PRIVATE-TENANT-SUBSCRIPTION',
      });
    });

    it('rejects a fixture with a status outside SubscriptionView', () => {
      expect(() =>
        validator.assertResponse(subscriptionPath, 'get', 200, {
          status: 'PendingReview',
        }),
      ).toThrow(/does not match its declared schema/);
    });
  });

  describe('GET /billing/payment-submissions', () => {
    it("200: this tenant's submissions conform to PaymentSubmissionView[]", () => {
      coverage.record(submissionsPath, 'get', 200, [
        {
          id: '57000000-0000-4000-8000-000000000001',
          status: 'PendingReview',
          submittedAt: '2026-10-10T05:57:00.000Z',
          statusHistory: [
            {
              status: 'PendingReview',
              changedAt: '2026-10-10T05:57:00.000Z',
              changedBy: '57000000-0000-4000-8000-000000000002',
              notes: 'T057 private fixture',
            },
          ],
        },
      ]);
    });

    it('rejects a fixture with a non-UUID submission id', () => {
      expect(() =>
        validator.assertResponse(submissionsPath, 'get', 200, [
          {
            id: 't057-not-a-uuid',
            status: 'PendingReview',
            submittedAt: '2026-10-10T05:57:00.000Z',
            statusHistory: [],
          },
        ]),
      ).toThrow(/does not match its declared schema/);
    });
  });

  describe('POST /billing/payment-submissions', () => {
    it('accepts a valid multipart PaymentSubmissionInput fixture', () => {
      expect(() =>
        validator.validateRequestBody(
          submissionsPath,
          'post',
          {
            bankReference: 'T057-PRIVATE-BANK-REFERENCE',
            proofFile: 't057-private-proof.pdf',
          },
          'multipart/form-data',
        ),
      ).not.toThrow();
    });

    it('rejects a multipart fixture without proofFile', () => {
      expect(() =>
        validator.validateRequestBody(
          submissionsPath,
          'post',
          { bankReference: 'T057-PRIVATE-BANK-REFERENCE' },
          'multipart/form-data',
        ),
      ).toThrow(/proofFile/);
    });

    it.each([201, 409, 422] as const)('%i: exercises the documented response status', (status) => {
      coverage.record(submissionsPath, 'post', status, undefined);
    });
  });

  describe('coverage (T057 acceptance criterion)', () => {
    it('exercises every documented response code for all three operations', () => {
      coverage.assertFullCoverage(subscriptionPath, 'get');
      coverage.assertFullCoverage(submissionsPath, 'get');
      coverage.assertFullCoverage(submissionsPath, 'post');
    });
  });
});
