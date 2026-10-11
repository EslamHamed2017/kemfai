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
} from '../../src/modules/billing-customer/entities/payment-submission.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

const ISSUER = 'http://127.0.0.1/realms/kemfai-internal-t065';
const AUDIENCE = 'kemfai-api-t065';
const BILLING_PERIOD_START = '2026-10-01';
const BILLING_PERIOD_END = '2026-10-31';
const ACTIVATION_ACTION = 'billing.subscription.activated';

/**
 * T065 test-first integration specification.
 *
 * This suite boots the production AppModule and sends two genuinely concurrent HTTP requests
 * against a label-owned PostgreSQL fixture. It supplies no probe controller and mocks no billing
 * route or persistence behavior. The localhost JWKS server is an identity fixture configured for
 * BearerAuthGuard's real remote-key verification path once the production route exists; the
 * current route-lookup RED is not a claim that auth ran or that external Keycloak was covered.
 *
 * T069 owns the approve endpoint implementation. Until T069 registers that production route, the
 * status assertion below is intentionally RED with [404, 404], precisely identifying the missing
 * endpoint without manufacturing a false GREEN or implementing later-task scope here.
 */
describe('Billing approval concurrency (T065)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let keycloak: FakeKeycloak;
  let billingAdminToken: string;

  const label = `t065-${randomUUID()}`;
  const planId = randomUUID();
  const ownerAccountId = randomUUID();
  const billingAdminAccountId = randomUUID();
  const tenantId = randomUUID();
  const subscriptionId = randomUUID();
  const submissionId = randomUUID();
  const originalAuthEnvironment = {
    issuer: process.env.KEYCLOAK_ISSUER,
    audience: process.env.KEYCLOAK_API_AUDIENCE,
    jwksUri: process.env.KEYCLOAK_JWKS_URI,
  };

  beforeAll(async () => {
    keycloak = await startFakeKeycloak({ issuer: ISSUER, audience: AUDIENCE });
    process.env.KEYCLOAK_ISSUER = ISSUER;
    process.env.KEYCLOAK_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;

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
        name: `T065 private fixture ${label}`,
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
        minioBucket: `kemfai-tenant-${label}`,
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
        bankReference: `T065-${label}`,
        proofObjectKey: `payment-submissions/${label}/proof.pdf`,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        statusHistory: [
          {
            status: PaymentSubmissionStatus.PENDING_REVIEW,
            changedAt: new Date().toISOString(),
            changedBy: ownerAccountId,
            notes: null,
          },
        ],
      }),
    );

    billingAdminToken = await keycloak.signAccessToken({
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
      if (keycloak) await attempt(() => keycloak.close());
      if (controlDataSource.isInitialized) await attempt(() => controlDataSource.destroy());
      restoreEnvironment('KEYCLOAK_ISSUER', originalAuthEnvironment.issuer);
      restoreEnvironment('KEYCLOAK_API_AUDIENCE', originalAuthEnvironment.audience);
      restoreEnvironment('KEYCLOAK_JWKS_URI', originalAuthEnvironment.jwksUri);
    }

    if (cleanupError) throw cleanupError;
  }, 60_000);

  it('allows exactly one of two concurrent approvals and emits one activation event', async () => {
    const precondition = await readDecisionState();
    expect(precondition).toEqual({
      subscriptionStatus: SubscriptionStatus.PENDING_ACTIVATION,
      submissionStatus: PaymentSubmissionStatus.PENDING_REVIEW,
      activationEvents: 0,
    });

    const approvePath = `/internal/billing/payment-submissions/${submissionId}/approve`;
    const issueApproval = () =>
      request(baseUrl)
        .post(approvePath)
        .set('Authorization', `Bearer ${billingAdminToken}`)
        .set('Accept', 'application/json')
        .set('Origin', 'http://127.0.0.1')
        .set('X-Requested-With', 'XMLHttpRequest');

    const responses = await Promise.all([issueApproval(), issueApproval()]);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);

    const activeSubscriptions = (await controlDataSource.query(
      `SELECT id, activated_by, activated_at
         FROM subscription
        WHERE tenant_id = $1
          AND current_period_start = $2::date
          AND current_period_end = $3::date
          AND status = 'Active'::subscription_status_enum`,
      [tenantId, BILLING_PERIOD_START, BILLING_PERIOD_END],
    )) as Array<{ id: string; activated_by: string | null; activated_at: Date | null }>;
    expect(activeSubscriptions).toHaveLength(1);
    expect(activeSubscriptions[0]).toMatchObject({
      id: subscriptionId,
      activated_by: billingAdminAccountId,
    });
    expect(activeSubscriptions[0].activated_at).toBeInstanceOf(Date);

    const submission = await controlDataSource
      .getRepository(PaymentSubmission)
      .findOneByOrFail({ id: submissionId });
    expect(submission.status).toBe(PaymentSubmissionStatus.APPROVED);

    const activationEvents = (await controlDataSource.query(
      `SELECT action, subject_type, subject_id, actor_id, tenant_id
         FROM audit_event
        WHERE tenant_id = $1 AND action = $2`,
      [tenantId, ACTIVATION_ACTION],
    )) as Array<{
      action: string;
      subject_type: string;
      subject_id: string;
      actor_id: string | null;
      tenant_id: string | null;
    }>;
    expect(activationEvents).toEqual([
      {
        action: ACTIVATION_ACTION,
        subject_type: 'Subscription',
        subject_id: subscriptionId,
        actor_id: billingAdminAccountId,
        tenant_id: tenantId,
      },
    ]);
  });

  async function readDecisionState(): Promise<{
    subscriptionStatus: string;
    submissionStatus: string;
    activationEvents: number;
  }> {
    const [subscription, submission, eventRows] = await Promise.all([
      controlDataSource.getRepository(Subscription).findOneByOrFail({ id: subscriptionId }),
      controlDataSource.getRepository(PaymentSubmission).findOneByOrFail({ id: submissionId }),
      controlDataSource.query(
        'SELECT COUNT(*)::int AS count FROM audit_event WHERE tenant_id = $1 AND action = $2',
        [tenantId, ACTIVATION_ACTION],
      ) as Promise<Array<{ count: number }>>,
    ]);
    return {
      subscriptionStatus: subscription.status,
      submissionStatus: submission.status,
      activationEvents: eventRows[0].count,
    };
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
