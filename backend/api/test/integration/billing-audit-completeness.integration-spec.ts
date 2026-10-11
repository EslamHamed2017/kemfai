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
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

const ISSUER = 'http://127.0.0.1/realms/kemfai-internal-t066';
const AUDIENCE = 'kemfai-api-t066';
const BILLING_PERIOD_START = '2026-10-01';
const BILLING_PERIOD_END = '2026-10-31';
const AMOUNT = '1250.50';
const CURRENCY = 'AED';
const DECIDED_ACTION = 'billing.payment_submission.decided';
const ACTIVATED_ACTION = 'billing.subscription.activated';
const AUDIT_ACTIONS = [DECIDED_ACTION, ACTIVATED_ACTION] as const;

// FR-009, verbatim and in specification order. Payload keys use the repository's established
// snake_case audit convention; "proof document reference" is deliberately not shortened to the
// storage implementation's proof_object_key name.
const FR_009_FIELDS = [
  'customer',
  'tenant',
  'plan',
  'billing_period',
  'amount',
  'currency',
  'bank_reference',
  'proof_document_reference',
  'reviewed_by',
  'reviewed_at',
  'activation_decision',
  'activated_by',
  'activated_at',
  'notes',
  'status_history',
] as const;

const FR_009_NON_NULL_FIELDS = FR_009_FIELDS.filter((field) => field !== 'notes');

interface BillingAuditRow {
  action: (typeof AUDIT_ACTIONS)[number];
  actor_type: string;
  actor_id: string | null;
  tenant_id: string | null;
  subject_type: string;
  subject_id: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
}

/**
 * T066 test-first integration specification.
 *
 * This suite boots the production AppModule behind a real localhost HTTP listener and uses
 * UUID-owned PostgreSQL rows. It supplies no probe controller and mocks neither the approval
 * route nor persistence. T069 owns that production route and both audit emissions, so the
 * contracted 200 assertion is intentionally RED with actual 404 until T069 is implemented.
 * The downstream assertions already cover every FR-009 field on every decided/activated event;
 * they must not be described as executed while route lookup remains the first failure.
 *
 * The localhost JWKS server is an explicit identity fixture for BearerAuthGuard's real remote-key
 * verification path once the route exists; it is not a claim of external Keycloak coverage.
 */
describe('Billing audit completeness (T066)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let keycloak: FakeKeycloak;
  let billingAdminToken: string;

  const label = `t066-${randomUUID()}`;
  const planId = randomUUID();
  const ownerAccountId = randomUUID();
  const billingAdminAccountId = randomUUID();
  const tenantId = randomUUID();
  const subscriptionId = randomUUID();
  const submissionId = randomUUID();
  const bankReference = `T066-${label}`;
  const proofDocumentReference = `payment-submissions/${label}/proof.pdf`;
  const initialHistory: PaymentSubmissionStatusHistoryEntry[] = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: new Date('2026-10-11T08:00:00.000Z').toISOString(),
      changedBy: ownerAccountId,
      notes: null,
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
    keycloak = await startFakeKeycloak({ issuer: ISSUER, audience: AUDIENCE });
    process.env.KEYCLOAK_ISSUER = ISSUER;
    process.env.KEYCLOAK_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;
    process.env.KEYCLOAK_INTERNAL_ISSUER = ISSUER;
    process.env.KEYCLOAK_INTERNAL_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_INTERNAL_JWKS_URI = keycloak.jwksUri;

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
        name: `T066 private fixture ${label}`,
        published: false,
        monthlyPrice: AMOUNT,
        annualPrice: '12505.00',
        currency: CURRENCY,
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
        amount: AMOUNT,
        currency: CURRENCY,
        bankReference,
        proofObjectKey: proofDocumentReference,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        statusHistory: initialHistory,
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
      restoreEnvironment('KEYCLOAK_INTERNAL_ISSUER', originalAuthEnvironment.internalIssuer);
      restoreEnvironment(
        'KEYCLOAK_INTERNAL_API_AUDIENCE',
        originalAuthEnvironment.internalAudience,
      );
      restoreEnvironment('KEYCLOAK_INTERNAL_JWKS_URI', originalAuthEnvironment.internalJwksUri);
    }

    if (cleanupError) throw cleanupError;
  }, 60_000);

  it('records every FR-009 field on every billing decision and activation event', async () => {
    const precondition = await readFixtureState();
    expect(precondition).toEqual({
      subscriptionStatus: SubscriptionStatus.PENDING_ACTIVATION,
      submissionStatus: PaymentSubmissionStatus.PENDING_REVIEW,
      billingAuditEvents: 0,
    });

    const response = await request(baseUrl)
      .post(`/internal/billing/payment-submissions/${submissionId}/approve`)
      .set('Authorization', `Bearer ${billingAdminToken}`)
      .set('Accept', 'application/json')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Requested-With', 'XMLHttpRequest');

    expect(response.status).toBe(200);

    const submission = await controlDataSource
      .getRepository(PaymentSubmission)
      .findOneByOrFail({ id: submissionId });
    expect(submission.status).toBe(PaymentSubmissionStatus.APPROVED);
    expect(submission.reviewedBy).toBe(billingAdminAccountId);
    expect(submission.reviewedAt).toBeInstanceOf(Date);
    expect(submission.statusHistory).toHaveLength(initialHistory.length + 1);
    expect(submission.statusHistory[submission.statusHistory.length - 1]).toMatchObject({
      status: PaymentSubmissionStatus.APPROVED,
      changedBy: billingAdminAccountId,
    });

    const subscription = await controlDataSource
      .getRepository(Subscription)
      .findOneByOrFail({ id: subscriptionId });
    expect(subscription).toMatchObject({
      status: SubscriptionStatus.ACTIVE,
      activatedBy: billingAdminAccountId,
    });
    expect(subscription.activatedAt).toBeInstanceOf(Date);

    const rows = (await controlDataSource.query(
      `SELECT action, actor_type, actor_id, tenant_id, subject_type, subject_id, occurred_at, payload
         FROM audit_event
        WHERE tenant_id = $1
          AND action = ANY($2::text[])
        ORDER BY created_at, id`,
      [tenantId, AUDIT_ACTIONS],
    )) as BillingAuditRow[];

    expect(rows).toHaveLength(2);
    expect(rows.map(({ action }) => action).sort()).toEqual([...AUDIT_ACTIONS].sort());

    for (const row of rows) {
      expect(row).toMatchObject({
        actor_type: 'internal_user',
        actor_id: billingAdminAccountId,
        tenant_id: tenantId,
      });
      expect(row.occurred_at).toBeInstanceOf(Date);

      expect(Object.keys(row.payload)).toEqual(expect.arrayContaining([...FR_009_FIELDS]));
      for (const field of FR_009_NON_NULL_FIELDS) {
        expect(row.payload).toHaveProperty(field);
        expect(row.payload[field]).not.toBeNull();
      }
      expect(row.payload).toHaveProperty('notes');

      expect(row.payload).toMatchObject({
        customer: ownerAccountId,
        tenant: tenantId,
        plan: planId,
        billing_period: {
          start: BILLING_PERIOD_START,
          end: BILLING_PERIOD_END,
        },
        amount: AMOUNT,
        currency: CURRENCY,
        bank_reference: bankReference,
        proof_document_reference: proofDocumentReference,
        reviewed_by: billingAdminAccountId,
        reviewed_at: submission.reviewedAt?.toISOString(),
        activation_decision: 'approve',
        activated_by: billingAdminAccountId,
        activated_at: subscription.activatedAt?.toISOString(),
        notes: submission.decisionNotes,
        status_history: submission.statusHistory,
      });
      expectValidTimestamp(row.payload.reviewed_at);
      expectValidTimestamp(row.payload.activated_at);
    }

    const decidedEvent = rows.find(({ action }) => action === DECIDED_ACTION);
    expect(decidedEvent).toMatchObject({
      subject_type: 'payment_submission',
      subject_id: submissionId,
    });

    const activatedEvent = rows.find(({ action }) => action === ACTIVATED_ACTION);
    expect(activatedEvent).toMatchObject({
      subject_type: 'subscription',
      subject_id: subscriptionId,
    });
  });

  async function readFixtureState(): Promise<{
    subscriptionStatus: string;
    submissionStatus: string;
    billingAuditEvents: number;
  }> {
    const [subscription, submission, eventRows] = await Promise.all([
      controlDataSource.getRepository(Subscription).findOneByOrFail({ id: subscriptionId }),
      controlDataSource.getRepository(PaymentSubmission).findOneByOrFail({ id: submissionId }),
      controlDataSource.query(
        'SELECT COUNT(*)::int AS count FROM audit_event WHERE tenant_id = $1 AND action = ANY($2::text[])',
        [tenantId, AUDIT_ACTIONS],
      ) as Promise<Array<{ count: number }>>,
    ]);
    return {
      subscriptionStatus: subscription.status,
      submissionStatus: submission.status,
      billingAuditEvents: eventRows[0].count,
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
