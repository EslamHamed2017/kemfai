import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import {
  QUEUE_NOTIFICATION_BILLING_DECISION,
  billingDecisionNotificationJobId,
} from '../../src/common/queues/queue-names';
import { redisConnectionFromUrl } from '../../src/common/queues/redis-connection';
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

const CUSTOMER_ISSUER = 'http://127.0.0.1/realms/kemfai-customers-t070';
const INTERNAL_ISSUER = 'http://127.0.0.1/realms/kemfai-internal-t070';
const AUDIENCE = 'kemfai-api-t070';
const REJECT_PERIOD_START = '2026-11-01';
const REJECT_PERIOD_END = '2026-11-30';
const MORE_INFO_PERIOD_START = '2026-12-01';
const MORE_INFO_PERIOD_END = '2026-12-31';
const CONCURRENCY_PERIOD_START = '2027-01-01';
const CONCURRENCY_PERIOD_END = '2027-01-31';
const ALREADY_DECIDED_PERIOD_START = '2027-02-01';
const ALREADY_DECIDED_PERIOD_END = '2027-02-28';
const REJECT_REASON = 'The transferred amount does not match the amount due for this period.';
const MORE_INFO_DETAILS = 'Please provide a bank confirmation showing the beneficiary account.';
const DECIDED_ACTION = 'billing.payment_submission.decided';
const ACTIVATED_ACTION = 'billing.subscription.activated';

// FR-009 field list, verbatim (same contract the T066 suite asserts for approvals). For
// reject/more_info the two activation-specific fields are present but null — no activation
// happened, and the audit must say so truthfully rather than fabricate one.
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

const FR_009_NON_NULL_FIELDS = FR_009_FIELDS.filter(
  (field) => field !== 'notes' && field !== 'activated_by' && field !== 'activated_at',
);

interface DecidedEventRow {
  actor_type: string;
  actor_id: string | null;
  tenant_id: string | null;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
}

/**
 * T070 test-first integration specification for Acceptance Scenarios 6.3/6.4.
 *
 * Boots the production AppModule behind a real localhost HTTP listener with UUID-owned
 * PostgreSQL rows and the real Redis-backed `notification.billing_decision` queue (the
 * Jest integration fixture isolates Redis to DB 14). Nothing about the decision routes,
 * persistence, audit, or notification enqueue is mocked. While the T070 routes are
 * missing, every contracted 200 below is intentionally RED with an actual 404.
 *
 * The internal Billing Admin subject deliberately has NO customer Account row: reviewer
 * identity must be carried by the internal realm subject itself (T069 identity doctrine),
 * with the customer-only `reviewed_by` Account FK left null.
 */
describe('Billing Admin reject and request-more-info decisions (T070)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let customerKeycloak: FakeKeycloak;
  let internalKeycloak: FakeKeycloak;
  let notificationQueue: Queue;
  let ownerToken: string;
  let billingAdminToken: string;

  const label = `t070-${randomUUID()}`;
  const planId = randomUUID();
  const ownerAccountId = randomUUID();
  const billingAdminSubject = randomUUID();
  const tenantId = randomUUID();
  const subscriptionId = randomUUID();
  const rejectSubmissionId = randomUUID();
  const moreInfoSubmissionId = randomUUID();
  const concurrencySubmissionId = randomUUID();
  const alreadyDecidedSubmissionId = randomUUID();
  const initialRejectHistory: PaymentSubmissionStatusHistoryEntry[] = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-11-02T08:00:00.000Z',
      changedBy: ownerAccountId,
      notes: null,
    },
  ];
  const initialAlreadyDecidedHistory: PaymentSubmissionStatusHistoryEntry[] = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2027-02-02T08:00:00.000Z',
      changedBy: ownerAccountId,
      notes: null,
    },
  ];
  const initialConcurrencyHistory: PaymentSubmissionStatusHistoryEntry[] = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2027-01-02T08:00:00.000Z',
      changedBy: ownerAccountId,
      notes: null,
    },
  ];
  // One previously completed more-info/resubmission cycle, like the T067 fixture: the T070
  // request below must append after it and become the customer-visible latest request.
  const priorMoreInfoHistory: PaymentSubmissionStatusHistoryEntry[] = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-12-02T08:00:00.000Z',
      changedBy: ownerAccountId,
      notes: null,
    },
    {
      status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
      changedAt: '2026-12-03T08:00:00.000Z',
      changedBy: billingAdminSubject,
      notes: 'Please provide the transfer receipt.',
    },
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-12-04T08:00:00.000Z',
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

    notificationQueue = new Queue(QUEUE_NOTIFICATION_BILLING_DECISION, {
      connection: redisConnectionFromUrl(),
    });
    // Best-effort removal of any jobs a previously failed run of this suite left behind —
    // precise per-suite keys, never a queue-wide drain that could race a parallel suite.
    for (const submissionId of [
      rejectSubmissionId,
      moreInfoSubmissionId,
      concurrencySubmissionId,
      alreadyDecidedSubmissionId,
    ]) {
      for (const decision of ['reject', 'more_info', 'approve'] as const) {
        for (let occurrence = 0; occurrence < 8; occurrence += 1) {
          await notificationQueue
            .remove(billingDecisionNotificationJobId(submissionId, decision, occurrence))
            .catch(() => undefined);
        }
      }
    }

    const planRepository = controlDataSource.getRepository(Plan);
    await planRepository.save(
      planRepository.create({
        id: planId,
        name: `T070 private fixture ${label}`,
        published: false,
        monthlyPrice: '1250.50',
        annualPrice: '12505.00',
        currency: 'AED',
      }),
    );

    // Only a customer Account exists: the internal Billing Admin subject has no mirror row.
    const accountRepository = controlDataSource.getRepository(Account);
    await accountRepository.save(
      accountRepository.create({
        id: ownerAccountId,
        keycloakUserId: ownerAccountId,
        email: `${label}-owner@example.invalid`,
        emailVerified: true,
        selectedPlanId: planId,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
    );

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
        currentPeriodStart: REJECT_PERIOD_START,
        currentPeriodEnd: REJECT_PERIOD_END,
      }),
    );

    const submissionRepository = controlDataSource.getRepository(PaymentSubmission);
    await submissionRepository.save([
      submissionRepository.create({
        id: rejectSubmissionId,
        tenantId,
        subscriptionId,
        billingPeriodStart: REJECT_PERIOD_START,
        billingPeriodEnd: REJECT_PERIOD_END,
        amount: '1250.50',
        currency: 'AED',
        bankReference: `T070-REJECT-${label}`,
        proofObjectKey: `payment-submissions/${rejectSubmissionId}/proof.pdf`,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        statusHistory: initialRejectHistory,
      }),
      submissionRepository.create({
        id: moreInfoSubmissionId,
        tenantId,
        subscriptionId,
        billingPeriodStart: MORE_INFO_PERIOD_START,
        billingPeriodEnd: MORE_INFO_PERIOD_END,
        amount: '1250.50',
        currency: 'AED',
        bankReference: `T070-MORE-INFO-${label}`,
        proofObjectKey: `payment-submissions/${moreInfoSubmissionId}/proof.pdf`,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        statusHistory: priorMoreInfoHistory,
      }),
      submissionRepository.create({
        id: concurrencySubmissionId,
        tenantId,
        subscriptionId,
        billingPeriodStart: CONCURRENCY_PERIOD_START,
        billingPeriodEnd: CONCURRENCY_PERIOD_END,
        amount: '1250.50',
        currency: 'AED',
        bankReference: `T070-CONCURRENCY-${label}`,
        proofObjectKey: `payment-submissions/${concurrencySubmissionId}/proof.pdf`,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        statusHistory: initialConcurrencyHistory,
      }),
      submissionRepository.create({
        id: alreadyDecidedSubmissionId,
        tenantId,
        subscriptionId,
        billingPeriodStart: ALREADY_DECIDED_PERIOD_START,
        billingPeriodEnd: ALREADY_DECIDED_PERIOD_END,
        amount: '1250.50',
        currency: 'AED',
        bankReference: `T070-ALREADY-DECIDED-${label}`,
        proofObjectKey: `payment-submissions/${alreadyDecidedSubmissionId}/proof.pdf`,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        statusHistory: initialAlreadyDecidedHistory,
      }),
    ]);

    ownerToken = await customerKeycloak.signAccessToken({
      sub: ownerAccountId,
      roles: ['WorkspaceOwner'],
      tenantId,
    });
    billingAdminToken = await internalKeycloak.signAccessToken({
      sub: billingAdminSubject,
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
      if (notificationQueue) {
        // The outbox rows enumerate every occurrence-keyed job this suite's decisions
        // created; belt-and-braces the seeded history also gets swept by pattern.
        if (controlDataSource.isInitialized) {
          const rows = (await controlDataSource.query(
            'SELECT job_id FROM billing_decision_notification_outbox WHERE tenant_id = $1',
            [tenantId],
          )) as Array<{ job_id: string }>;
          for (const row of rows) {
            await attempt(() => notificationQueue.remove(row.job_id));
          }
        }
        for (const submissionId of [
          rejectSubmissionId,
          moreInfoSubmissionId,
          concurrencySubmissionId,
          alreadyDecidedSubmissionId,
        ]) {
          for (const decision of ['reject', 'more_info', 'approve'] as const) {
            for (let occurrence = 0; occurrence < 8; occurrence += 1) {
              await attempt(() =>
                notificationQueue
                  .remove(billingDecisionNotificationJobId(submissionId, decision, occurrence))
                  .catch(() => undefined),
              );
            }
          }
        }
        await attempt(() => notificationQueue.close());
      }
      if (controlDataSource.isInitialized) {
        await attempt(() =>
          controlDataSource.query('DELETE FROM audit_event WHERE tenant_id = $1', [tenantId]),
        );
        await attempt(() =>
          controlDataSource.query('DELETE FROM payment_submission WHERE id = ANY($1::uuid[])', [
            [
              rejectSubmissionId,
              moreInfoSubmissionId,
              concurrencySubmissionId,
              alreadyDecidedSubmissionId,
            ],
          ]),
        );
        await attempt(() =>
          controlDataSource.query('DELETE FROM subscription WHERE id = $1', [subscriptionId]),
        );
        await attempt(() =>
          controlDataSource.query('DELETE FROM tenant WHERE id = $1', [tenantId]),
        );
        await attempt(() =>
          controlDataSource.query('DELETE FROM account WHERE id = $1', [ownerAccountId]),
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

  it('rejects with a mandatory audited reason, leaves the subscription unactivated, and notifies (6.3)', async () => {
    const response = await postDecision(rejectSubmissionId, 'reject', { reason: REJECT_REASON });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      submissionId: rejectSubmissionId,
      status: PaymentSubmissionStatus.REJECTED,
      decision: 'reject',
      decisionNotes: REJECT_REASON,
    });

    const submission = await controlDataSource
      .getRepository(PaymentSubmission)
      .findOneByOrFail({ id: rejectSubmissionId });
    expect(submission).toMatchObject({
      status: PaymentSubmissionStatus.REJECTED,
      decisionNotes: REJECT_REASON,
      reviewedBy: null,
    });
    expect(submission.reviewedAt).toBeInstanceOf(Date);
    expect(submission.statusHistory).toEqual([
      ...initialRejectHistory,
      expect.objectContaining({
        status: PaymentSubmissionStatus.REJECTED,
        changedBy: billingAdminSubject,
        notes: REJECT_REASON,
      }),
    ]);

    // Scenario 6.3: "the subscription remains unactivated".
    const subscription = await controlDataSource
      .getRepository(Subscription)
      .findOneByOrFail({ id: subscriptionId });
    expect(subscription).toMatchObject({
      status: SubscriptionStatus.PENDING_ACTIVATION,
      activatedBy: null,
    });
    expect(subscription.activatedAt).toBeNull();

    // One decided event with the full FR-009 field set; NO activation event exists.
    const decidedRows = await readDecidedEvents(rejectSubmissionId);
    expect(decidedRows).toHaveLength(1);
    const event = decidedRows[0];
    expect(event).toMatchObject({
      actor_type: 'internal_user',
      actor_id: billingAdminSubject,
      tenant_id: tenantId,
      subject_type: 'payment_submission',
      subject_id: rejectSubmissionId,
    });
    expect(Object.keys(event.payload)).toEqual(expect.arrayContaining([...FR_009_FIELDS]));
    for (const field of FR_009_NON_NULL_FIELDS) {
      expect(event.payload[field]).not.toBeNull();
    }
    expect(event.payload).toMatchObject({
      customer: ownerAccountId,
      tenant: tenantId,
      plan: planId,
      billing_period: { start: REJECT_PERIOD_START, end: REJECT_PERIOD_END },
      amount: '1250.50',
      currency: 'AED',
      bank_reference: `T070-REJECT-${label}`,
      proof_document_reference: `payment-submissions/${rejectSubmissionId}/proof.pdf`,
      reviewed_by: billingAdminSubject,
      decision: 'reject',
      activation_decision: 'reject',
      activated_by: null,
      activated_at: null,
      notes: REJECT_REASON,
      status_history: submission.statusHistory,
    });
    expectValidTimestamp(event.payload.reviewed_at as string);

    expect(await countActivationEvents()).toBe(0);

    // events.md: notification.billing_decision keyed by submission_id + decision +
    // decision occurrence (status_history cycle index — initialRejectHistory has one
    // entry, so this rejection's own history entry is occurrence 1).
    const job = await notificationQueue.getJob(
      billingDecisionNotificationJobId(rejectSubmissionId, 'reject', 1),
    );
    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({
      submissionId: rejectSubmissionId,
      tenantId,
      decision: 'reject',
      notes: REJECT_REASON,
    });
  });

  it('requests more information, keeps every cycle, and shows the customer the latest request (6.4)', async () => {
    const response = await postDecision(moreInfoSubmissionId, 'request-more-info', {
      details: MORE_INFO_DETAILS,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      submissionId: moreInfoSubmissionId,
      status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
      decision: 'more_info',
      decisionNotes: MORE_INFO_DETAILS,
    });

    // The customer-visible view always shows the latest request (Edge Cases).
    const customerResponse = await request(baseUrl)
      .get('/billing/payment-submissions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Accept', 'application/json')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(customerResponse.status).toBe(200);
    const customerView = (customerResponse.body as PaymentSubmissionView[]).find(
      ({ id }) => id === moreInfoSubmissionId,
    );
    expect(customerView).toBeDefined();
    expect(customerView).toMatchObject({ status: PaymentSubmissionStatus.MORE_INFO_REQUESTED });
    expect(customerView!.statusHistory).toEqual([
      ...priorMoreInfoHistory,
      expect.objectContaining({
        status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
        changedBy: billingAdminSubject,
        notes: MORE_INFO_DETAILS,
      }),
    ]);

    const submission = await controlDataSource
      .getRepository(PaymentSubmission)
      .findOneByOrFail({ id: moreInfoSubmissionId });
    expect(submission).toMatchObject({
      status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
      decisionNotes: MORE_INFO_DETAILS,
      reviewedBy: null,
      statusHistory: customerView!.statusHistory,
    });
    expect(submission.reviewedAt).toBeInstanceOf(Date);

    const subscription = await controlDataSource
      .getRepository(Subscription)
      .findOneByOrFail({ id: subscriptionId });
    expect(subscription.status).toBe(SubscriptionStatus.PENDING_ACTIVATION);

    const decidedRows = await readDecidedEvents(moreInfoSubmissionId);
    expect(decidedRows).toHaveLength(1);
    expect(decidedRows[0].payload).toMatchObject({
      decision: 'more_info',
      activation_decision: 'more_info',
      activated_by: null,
      activated_at: null,
      notes: MORE_INFO_DETAILS,
      reviewed_by: billingAdminSubject,
      status_history: submission.statusHistory,
    });
    expect(await countActivationEvents()).toBe(0);

    // priorMoreInfoHistory has three entries; this decision appends its own entry at
    // index 3 — a distinct occurrence job from any prior more_info cycle (finding 2).
    const job = await notificationQueue.getJob(
      billingDecisionNotificationJobId(moreInfoSubmissionId, 'more_info', 3),
    );
    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({
      submissionId: moreInfoSubmissionId,
      tenantId,
      decision: 'more_info',
      notes: MORE_INFO_DETAILS,
    });
  });

  it('answers 422 before any mutation when the mandatory notes are missing or blank', async () => {
    for (const action of ['reject', 'request-more-info'] as const) {
      const notesKey = action === 'reject' ? 'reason' : 'details';
      for (const body of [{}, { [notesKey]: '' }, { [notesKey]: '   ' }, { [notesKey]: 42 }]) {
        const response = await postDecision(moreInfoSubmissionId, action, body);

        expect(response.status).toBe(422);
        expect(response.body).toMatchObject({ statusCode: 422 });
      }
    }

    // The 6.4 test above left this submission MoreInfoRequested; a malformed body must
    // not mutate it further.
    const submission = await controlDataSource
      .getRepository(PaymentSubmission)
      .findOneByOrFail({ id: moreInfoSubmissionId });
    expect(submission.status).toBe(PaymentSubmissionStatus.MORE_INFO_REQUESTED);
    expect(submission.statusHistory).toHaveLength(priorMoreInfoHistory.length + 1);
    expect(submission.statusHistory.slice(0, priorMoreInfoHistory.length)).toEqual(
      priorMoreInfoHistory,
    );
    expect(await countDecidedEvents()).toBe(2); // only the two decided events from the tests above
    // The 422 path enqueues nothing new: the two earlier occurrence jobs still exist,
    // no second occurrence for either submission does.
    expect(
      await notificationQueue.getJob(
        billingDecisionNotificationJobId(rejectSubmissionId, 'reject', 1),
      ),
    ).toBeDefined();
    expect(
      await notificationQueue.getJob(
        billingDecisionNotificationJobId(moreInfoSubmissionId, 'more_info', 3),
      ),
    ).toBeDefined();
    expect(
      await notificationQueue.getJob(
        billingDecisionNotificationJobId(rejectSubmissionId, 'reject', 2),
      ),
    ).toBeUndefined();
    expect(
      await notificationQueue.getJob(
        billingDecisionNotificationJobId(moreInfoSubmissionId, 'more_info', 4),
      ),
    ).toBeUndefined();
    expect(
      await notificationQueue.getJob(
        billingDecisionNotificationJobId(moreInfoSubmissionId, 'reject', 1),
      ),
    ).toBeUndefined();
    expect(
      await notificationQueue.getJob(
        billingDecisionNotificationJobId(alreadyDecidedSubmissionId, 'reject', 1),
      ),
    ).toBeUndefined();
  });

  it('answers 404 for an unknown submission on both decision routes', async () => {
    const unknownId = randomUUID();
    for (const action of ['reject', 'request-more-info'] as const) {
      const response = await postDecision(
        unknownId,
        action,
        action === 'reject' ? { reason: 'not found' } : { details: 'not found' },
      );

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ statusCode: 404 });
    }
  });

  it('blocks a second decision on an already-decided submission with 409 and no side effects', async () => {
    const first = await postDecision(alreadyDecidedSubmissionId, 'reject', {
      reason: 'Closing this cycle after all.',
    });
    expect(first.status).toBe(200);

    const decidedHistory = (
      await controlDataSource.getRepository(PaymentSubmission).findOneByOrFail({
        id: alreadyDecidedSubmissionId,
      })
    ).statusHistory;

    const second = await postDecision(alreadyDecidedSubmissionId, 'reject', {
      reason: 'Duplicate rejection.',
    });
    const moreInfo = await postDecision(alreadyDecidedSubmissionId, 'request-more-info', {
      details: 'Duplicate request.',
    });
    expect(second.status).toBe(409);
    expect(moreInfo.status).toBe(409);

    const submission = await controlDataSource
      .getRepository(PaymentSubmission)
      .findOneByOrFail({ id: alreadyDecidedSubmissionId });
    expect(submission.status).toBe(PaymentSubmissionStatus.REJECTED);
    expect(submission.statusHistory).toEqual(decidedHistory);

    // Exactly one decided event for this submission (from the successful rejection); the
    // 409 duplicates appended neither history nor audit rows.
    expect(await readDecidedEvents(alreadyDecidedSubmissionId)).toHaveLength(1);
    // Exactly one reject notification job exists — from the successful rejection, not
    // the 409s (idempotent for the SAME decision occurrence: one history entry, one job).
    const rejectJob = await notificationQueue.getJob(
      billingDecisionNotificationJobId(alreadyDecidedSubmissionId, 'reject', 1),
    );
    expect(rejectJob).toBeDefined();
    expect(rejectJob?.data).toMatchObject({
      submissionId: alreadyDecidedSubmissionId,
      decision: 'reject',
      notes: 'Closing this cycle after all.',
    });
    expect(
      await notificationQueue.getJob(
        billingDecisionNotificationJobId(alreadyDecidedSubmissionId, 'reject', 2),
      ),
    ).toBeUndefined();

    // A MoreInfoRequested row is not decidable either: it first needs the customer's
    // resubmission (data-model.md state machine, same source-state rule as T069 approve).
    const moreInfoOnAwaited = await postDecision(moreInfoSubmissionId, 'reject', {
      reason: 'Cannot decide while awaiting resubmission.',
    });
    expect(moreInfoOnAwaited.status).toBe(409);
    expect(await readDecidedEvents(moreInfoSubmissionId)).toHaveLength(1);
  });

  it('allows exactly one of two concurrent rejections on the same submission', async () => {
    const [first, second] = await Promise.all([
      postDecision(concurrencySubmissionId, 'reject', { reason: REJECT_REASON }),
      postDecision(concurrencySubmissionId, 'reject', { reason: REJECT_REASON }),
    ]);
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([200, 409]);

    const submission = await controlDataSource
      .getRepository(PaymentSubmission)
      .findOneByOrFail({ id: concurrencySubmissionId });
    expect(submission.status).toBe(PaymentSubmissionStatus.REJECTED);
    expect(submission.statusHistory).toHaveLength(initialConcurrencyHistory.length + 1);
    expect(await readDecidedEvents(concurrencySubmissionId)).toHaveLength(1);

    const job = await notificationQueue.getJob(
      billingDecisionNotificationJobId(concurrencySubmissionId, 'reject', 1),
    );
    expect(job).toBeDefined();
    expect(
      await notificationQueue.getJob(
        billingDecisionNotificationJobId(concurrencySubmissionId, 'reject', 2),
      ),
    ).toBeUndefined();
  });

  function postDecision(
    submissionId: string,
    action: 'reject' | 'request-more-info',
    body: Record<string, unknown>,
  ) {
    return request(baseUrl)
      .post(`/internal/billing/payment-submissions/${submissionId}/${action}`)
      .set('Authorization', `Bearer ${billingAdminToken}`)
      .set('Accept', 'application/json')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send(body);
  }

  function configureAuthRealms(): void {
    process.env.KEYCLOAK_ISSUER = CUSTOMER_ISSUER;
    process.env.KEYCLOAK_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_JWKS_URI = customerKeycloak.jwksUri;
    process.env.KEYCLOAK_INTERNAL_ISSUER = INTERNAL_ISSUER;
    process.env.KEYCLOAK_INTERNAL_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_INTERNAL_JWKS_URI = internalKeycloak.jwksUri;
  }

  async function readDecidedEvents(submissionId: string): Promise<DecidedEventRow[]> {
    return (await controlDataSource.query(
      `SELECT actor_type, actor_id, tenant_id, subject_type, subject_id, payload
         FROM audit_event
        WHERE tenant_id = $1 AND action = $2 AND subject_id = $3`,
      [tenantId, DECIDED_ACTION, submissionId],
    )) as DecidedEventRow[];
  }

  async function countDecidedEvents(): Promise<number> {
    const rows = (await controlDataSource.query(
      'SELECT COUNT(*)::int AS count FROM audit_event WHERE tenant_id = $1 AND action = $2',
      [tenantId, DECIDED_ACTION],
    )) as Array<{ count: number }>;
    return rows[0].count;
  }

  async function countActivationEvents(): Promise<number> {
    const rows = (await controlDataSource.query(
      'SELECT COUNT(*)::int AS count FROM audit_event WHERE tenant_id = $1 AND action = $2',
      [tenantId, ACTIVATED_ACTION],
    )) as Array<{ count: number }>;
    return rows[0].count;
  }

  async function fixtureResidueCount(): Promise<number> {
    const rows = (await controlDataSource.query(
      `SELECT
         (SELECT COUNT(*) FROM plan WHERE id = $1) +
         (SELECT COUNT(*) FROM account WHERE id = $2) +
         (SELECT COUNT(*) FROM tenant WHERE id = $3) +
         (SELECT COUNT(*) FROM subscription WHERE id = $4) +
         (SELECT COUNT(*) FROM payment_submission WHERE id = ANY($5::uuid[])) +
         (SELECT COUNT(*) FROM audit_event WHERE tenant_id = $3) AS count`,
      [
        planId,
        ownerAccountId,
        tenantId,
        subscriptionId,
        [
          rejectSubmissionId,
          moreInfoSubmissionId,
          concurrencySubmissionId,
          alreadyDecidedSubmissionId,
        ],
      ],
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
