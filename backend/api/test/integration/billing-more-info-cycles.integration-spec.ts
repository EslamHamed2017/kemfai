import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { Account, BillingCycle } from '../../src/modules/accounts/entities/account.entity';
import {
  PaymentSubmission,
  PaymentSubmissionStatus,
  PaymentSubmissionStatusHistoryEntry,
} from '../../src/modules/billing-customer/entities/payment-submission.entity';
import { PaymentSubmissionView } from '../../src/modules/billing-customer/billing-customer.service';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

const CUSTOMER_ISSUER = 'http://127.0.0.1/realms/kemfai-customers-t067';
const INTERNAL_ISSUER = 'http://127.0.0.1/realms/kemfai-internal-t067';
const AUDIENCE = 'kemfai-api-t067';
const BILLING_PERIOD_START = '2026-10-01';
const BILLING_PERIOD_END = '2026-10-31';
const FIRST_REQUEST = 'Please provide a receipt showing the beneficiary account.';
const LATEST_REQUEST = 'Please also provide the bank confirmation number.';

/**
 * T067 test-first integration specification.
 *
 * The UUID-owned fixture represents one completed request-more-info/resubmission cycle on the
 * same row and billing period. The test drives the next request through the production AppModule,
 * then reads the result through the customer-facing HTTP route. No billing route, persistence
 * behavior, or customer view is mocked. This keeps the test independent of MinIO while exercising
 * the append-only database history, the planned internal decision endpoint, and the real
 * customer-visible projection together.
 *
 * T070 owns the request-more-info production route. Until that task registers the route (and the
 * internal realm selection specified by T064), the contracted 200 assertion is intentionally RED
 * with an actual 404. The later assertions define the complete T067 behavior but must not be
 * described as executed while route lookup remains the first failure.
 */
describe('Repeated billing request-more-info cycles (T067)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let customerKeycloak: FakeKeycloak;
  let internalKeycloak: FakeKeycloak;
  let ownerToken: string;
  let billingAdminToken: string;

  const label = `t067-${randomUUID()}`;
  const planId = randomUUID();
  const ownerAccountId = randomUUID();
  const billingAdminAccountId = randomUUID();
  const tenantId = randomUUID();
  const subscriptionId = randomUUID();
  const submissionId = randomUUID();
  const currentBankReference = `T067-RESUBMITTED-${label}`;
  const currentProofObjectKey = `payment-submissions/${submissionId}/resubmitted-proof.pdf`;
  const seededHistory: PaymentSubmissionStatusHistoryEntry[] = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-10-01T08:00:00.000Z',
      changedBy: ownerAccountId,
      notes: null,
      bankReference: `T067-INITIAL-${label}`,
      proofObjectKey: `payment-submissions/${submissionId}/initial-proof.pdf`,
    },
    {
      status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
      changedAt: '2026-10-02T08:00:00.000Z',
      changedBy: billingAdminAccountId,
      notes: FIRST_REQUEST,
    },
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-10-03T08:00:00.000Z',
      changedBy: ownerAccountId,
      notes: null,
      bankReference: currentBankReference,
      proofObjectKey: currentProofObjectKey,
    },
  ];
  const originalAuthEnvironment = {
    issuer: process.env.KEYCLOAK_ISSUER,
    audience: process.env.KEYCLOAK_API_AUDIENCE,
    jwksUri: process.env.KEYCLOAK_JWKS_URI,
    internalIssuer: process.env.KEYCLOAK_INTERNAL_ISSUER,
    internalAudience: process.env.KEYCLOAK_INTERNAL_API_AUDIENCE,
    internalJwksUri: process.env.KEYCLOAK_INTERNAL_JWKS_URI,
  };

  beforeAll(async () => {
    customerKeycloak = await startFakeKeycloak({ issuer: CUSTOMER_ISSUER, audience: AUDIENCE });
    internalKeycloak = await startFakeKeycloak({ issuer: INTERNAL_ISSUER, audience: AUDIENCE });
    configureAuthRealms();

    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const planRepository = controlDataSource.getRepository(Plan);
    await planRepository.save(
      planRepository.create({
        id: planId,
        name: `T067 private fixture ${label}`,
        published: false,
        monthlyPrice: '1250.50',
        annualPrice: '12505.00',
        currency: 'AED',
      }),
    );

    const accountRepository = controlDataSource.getRepository(Account);
    await accountRepository.save([
      accountRepository.create({
        id: ownerAccountId,
        keycloakUserId: ownerAccountId,
        email: `${label}-owner@example.invalid`,
        emailVerified: true,
        selectedPlanId: planId,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
      accountRepository.create({
        id: billingAdminAccountId,
        keycloakUserId: billingAdminAccountId,
        email: `${label}-billing-admin@example.invalid`,
        emailVerified: true,
        selectedPlanId: null,
        selectedBillingCycle: null,
      }),
    ]);

    const tenantRepository = controlDataSource.getRepository(Tenant);
    await tenantRepository.save(
      tenantRepository.create({
        id: tenantId,
        accountId: ownerAccountId,
        status: TenantStatus.READY,
        readyAt: new Date(),
        minioBucket: `kemfai-tenant-${tenantId}`,
      }),
    );

    const subscriptionRepository = controlDataSource.getRepository(Subscription);
    await subscriptionRepository.save(
      subscriptionRepository.create({
        id: subscriptionId,
        tenantId,
        planId,
        billingCycle: SubscriptionBillingCycle.MONTHLY,
        status: SubscriptionStatus.PENDING_ACTIVATION,
        currentPeriodStart: BILLING_PERIOD_START,
        currentPeriodEnd: BILLING_PERIOD_END,
      }),
    );

    const submissionRepository = controlDataSource.getRepository(PaymentSubmission);
    await submissionRepository.save(
      submissionRepository.create({
        id: submissionId,
        tenantId,
        subscriptionId,
        billingPeriodStart: BILLING_PERIOD_START,
        billingPeriodEnd: BILLING_PERIOD_END,
        amount: '1250.50',
        currency: 'AED',
        bankReference: currentBankReference,
        proofObjectKey: currentProofObjectKey,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        reviewedBy: null,
        reviewedAt: null,
        decisionNotes: null,
        statusHistory: seededHistory,
      }),
    );

    ownerToken = await customerKeycloak.signAccessToken({
      sub: ownerAccountId,
      roles: ['WorkspaceOwner'],
      tenantId,
    });
    billingAdminToken = await internalKeycloak.signAccessToken({
      sub: billingAdminAccountId,
      roles: ['BillingAdmin'],
    });
  }, 60_000);

  afterAll(async () => {
    let cleanupError: unknown;
    const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        cleanupError ??= error;
      }
    };

    try {
      if (controlDataSource.isInitialized) {
        await attempt(() =>
          controlDataSource.query('DELETE FROM audit_event WHERE tenant_id = $1', [tenantId]),
        );
        await attempt(() =>
          controlDataSource.query('DELETE FROM payment_submission WHERE id = $1', [submissionId]),
        );
        await attempt(() =>
          controlDataSource.query('DELETE FROM subscription WHERE id = $1', [subscriptionId]),
        );
        await attempt(() =>
          controlDataSource.query('DELETE FROM tenant WHERE id = $1', [tenantId]),
        );
        await attempt(() =>
          controlDataSource.query('DELETE FROM account WHERE id = ANY($1::uuid[])', [
            [ownerAccountId, billingAdminAccountId],
          ]),
        );
        await attempt(() => controlDataSource.query('DELETE FROM plan WHERE id = $1', [planId]));
        await attempt(async () => expect(await fixtureResidueCount()).toBe(0));
      }
    } finally {
      if (app) await attempt(() => app.close());
      if (customerKeycloak) await attempt(() => customerKeycloak.close());
      if (internalKeycloak) await attempt(() => internalKeycloak.close());
      if (controlDataSource.isInitialized) await attempt(() => controlDataSource.destroy());
      restoreEnvironment('KEYCLOAK_ISSUER', originalAuthEnvironment.issuer);
      restoreEnvironment('KEYCLOAK_API_AUDIENCE', originalAuthEnvironment.audience);
      restoreEnvironment('KEYCLOAK_JWKS_URI', originalAuthEnvironment.jwksUri);
      restoreEnvironment('KEYCLOAK_INTERNAL_ISSUER', originalAuthEnvironment.internalIssuer);
      restoreEnvironment(
        'KEYCLOAK_INTERNAL_API_AUDIENCE',
        originalAuthEnvironment.internalAudience,
      );
      restoreEnvironment('KEYCLOAK_INTERNAL_JWKS_URI', originalAuthEnvironment.internalJwksUri);
    }

    if (cleanupError) throw cleanupError;
  }, 60_000);

  it('keeps every more-info cycle and shows the customer the latest request', async () => {
    const seeded = await controlDataSource
      .getRepository(PaymentSubmission)
      .findOneByOrFail({ id: submissionId });
    expect(seeded).toMatchObject({
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      decisionNotes: null,
      statusHistory: seededHistory,
    });

    const decisionResponse = await request(baseUrl)
      .post(`/internal/billing/payment-submissions/${submissionId}/request-more-info`)
      .set('Authorization', `Bearer ${billingAdminToken}`)
      .set('Accept', 'application/json')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ details: LATEST_REQUEST });

    expect(decisionResponse.status).toBe(200);

    const customerResponse = await request(baseUrl)
      .get('/billing/payment-submissions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Accept', 'application/json')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Requested-With', 'XMLHttpRequest');

    expect(customerResponse.status).toBe(200);
    const customerSubmissions = customerResponse.body as PaymentSubmissionView[];
    const customerView = customerSubmissions.find(({ id }) => id === submissionId);
    expect(customerView).toBeDefined();
    expect(customerView).toMatchObject({
      id: submissionId,
      status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
    });

    const visibleHistory = customerView!.statusHistory;
    expect(visibleHistory).toHaveLength(seededHistory.length + 1);
    expect(visibleHistory.slice(0, seededHistory.length)).toEqual(seededHistory);

    const visibleRequests = visibleHistory.filter(
      ({ status }) => status === PaymentSubmissionStatus.MORE_INFO_REQUESTED,
    );
    expect(visibleRequests).toHaveLength(2);
    expect(visibleRequests).toEqual([
      expect.objectContaining({
        status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
        changedBy: billingAdminAccountId,
        notes: FIRST_REQUEST,
      }),
      expect.objectContaining({
        status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
        changedBy: billingAdminAccountId,
        notes: LATEST_REQUEST,
      }),
    ]);
    expect(visibleHistory.at(-1)).toEqual(
      expect.objectContaining({
        status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
        changedBy: billingAdminAccountId,
        notes: LATEST_REQUEST,
      }),
    );
    expectValidTimestamp(visibleHistory.at(-1)?.changedAt);

    const persisted = await controlDataSource
      .getRepository(PaymentSubmission)
      .findOneByOrFail({ id: submissionId });
    expect(persisted).toMatchObject({
      status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
      reviewedBy: billingAdminAccountId,
      decisionNotes: LATEST_REQUEST,
      statusHistory: visibleHistory,
    });
    expect(persisted.reviewedAt).toBeInstanceOf(Date);
  });

  function configureAuthRealms(): void {
    process.env.KEYCLOAK_ISSUER = CUSTOMER_ISSUER;
    process.env.KEYCLOAK_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_JWKS_URI = customerKeycloak.jwksUri;
    process.env.KEYCLOAK_INTERNAL_ISSUER = INTERNAL_ISSUER;
    process.env.KEYCLOAK_INTERNAL_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_INTERNAL_JWKS_URI = internalKeycloak.jwksUri;
  }

  async function fixtureResidueCount(): Promise<number> {
    const rows = (await controlDataSource.query(
      `SELECT
         (SELECT COUNT(*) FROM plan WHERE id = $1) +
         (SELECT COUNT(*) FROM account WHERE id = ANY($2::uuid[])) +
         (SELECT COUNT(*) FROM tenant WHERE id = $3) +
         (SELECT COUNT(*) FROM subscription WHERE id = $4) +
         (SELECT COUNT(*) FROM payment_submission WHERE id = $5) +
         (SELECT COUNT(*) FROM audit_event WHERE tenant_id = $3) AS count`,
      [planId, [ownerAccountId, billingAdminAccountId], tenantId, subscriptionId, submissionId],
    )) as Array<{ count: string }>;
    return Number(rows[0].count);
  }
});

function expectValidTimestamp(value: unknown): void {
  expect(typeof value).toBe('string');
  expect(Number.isNaN(Date.parse(value as string))).toBe(false);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
