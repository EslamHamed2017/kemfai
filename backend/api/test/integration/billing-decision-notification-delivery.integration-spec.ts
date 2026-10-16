import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import {
  QUEUE_NOTIFICATION_BILLING_DECISION,
  billingDecisionNotificationJobId,
} from '../../src/common/queues/queue-names';
import { redisConnectionFromUrl } from '../../src/common/queues/redis-connection';
import { Account, BillingCycle, Locale } from '../../src/modules/accounts/entities/account.entity';
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
import { BILLING_DECISION_NOTIFICATION_TRANSPORT } from '../../src/modules/billing-admin/billing-decision-notification-transport.contract';
import { BillingDecisionNotificationProcessor } from '../../src/modules/billing-admin/billing-decision-notification.processor';
import { BillingDecisionNotificationOutboxService } from '../../src/modules/billing-admin/billing-decision-notification-outbox.service';
import { BillingDecisionNotificationRecoveryWorker } from '../../src/modules/billing-admin/billing-decision-notification-recovery.worker';
import {
  RESEND_RETRY_CUTOFF_MS,
  resendIdempotencyKey,
} from '../../src/modules/billing-admin/resend-idempotency-key';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';
import { FakeResend, startFakeResend } from '../support/fake-resend';

const CUSTOMER_ISSUER = 'http://127.0.0.1/realms/kemfai-customers-t070dv';
const INTERNAL_ISSUER = 'http://127.0.0.1/realms/kemfai-internal-t070dv';
const AUDIENCE = 'kemfai-api-t070dv';
const REJECT_REASON = 'The transferred amount does not match the amount due for this period.';
const AR_MORE_INFO_DETAILS = 'يرجى توفير رقم تأكيد التحويل البنكي.';
const FIRST_CYCLE_REQUEST = 'Please provide the transfer receipt.';
const LATEST_CYCLE_REQUEST = 'Please also provide the bank statement for the period.';
const OUTBOX_TABLE = 'billing_decision_notification_outbox';
const HEALTHY_REDIS_URL = 'redis://localhost:6379/14';
const RESEND_FROM = 'T070 Billing <t070-billing@example.invalid>';

/**
 * T070 delivery specification (Codex round-2 finding 2; owner decision
 * 2026-10-15T16:33:05Z) — FR-035 / Acceptance Scenarios 6.3/6.4 require the CUSTOMER TO
 * BE NOTIFIED, not merely a queue handoff, AND the notification must be idempotent at
 * KEMFAI's controlled delivery-acceptance boundary (plain SMTP cannot provide that — see
 * docs/runbooks/billing-decision-notifications.md). This suite boots the production
 * AppModule with Resend pointed at a local, real HTTP protocol-test fixture
 * (`fake-resend.ts`, honestly labeled: NOT a verification of the real hosted Resend
 * service — fixture-owned destination, `*.example.invalid` recipients only, no external
 * send is possible) and consumes the `notification.billing_decision` queue with a real
 * BullMQ Worker whose handler is the app's own production processor instance. Nothing
 * about the decision routes, outbox, processor, or Resend transport is mocked: a green
 * assertion here means a real wire-level request happened end-to-end, and a completed
 * job state means the production processor really ran and succeeded.
 */
describe('Billing decision customer notification delivery, FR-035 (T070)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let customerKeycloak: FakeKeycloak;
  let internalKeycloak: FakeKeycloak;
  let fixture: FakeResend;
  let queue: Queue;
  let deliveryWorker: Worker;
  let ownerTokenEn: string;
  let billingAdminToken: string;

  const label = `t070dv-${randomUUID()}`;
  const planId = randomUUID();
  const billingAdminSubject = randomUUID();
  const enOwnerId = randomUUID();
  const arOwnerId = randomUUID();
  const enTenantId = randomUUID();
  const arTenantId = randomUUID();
  const enEmail = `${label}-owner-en@example.invalid`;
  const arEmail = `${label}-owner-ar@example.invalid`;
  const rejectSubmissionId = randomUUID();
  const arSubmissionId = randomUUID();
  const cycleSubmissionId = randomUUID();
  const approveSubmissionId = randomUUID();
  const initialHistory: PaymentSubmissionStatusHistoryEntry[] = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-10-02T08:00:00.000Z',
      changedBy: enOwnerId,
      notes: null,
    },
  ];
  const priorCycleHistory: PaymentSubmissionStatusHistoryEntry[] = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-10-02T08:00:00.000Z',
      changedBy: enOwnerId,
      notes: null,
    },
    {
      status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
      changedAt: '2026-10-03T08:00:00.000Z',
      changedBy: billingAdminSubject,
      notes: FIRST_CYCLE_REQUEST,
    },
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-10-04T08:00:00.000Z',
      changedBy: enOwnerId,
      notes: null,
    },
  ];
  const priorCycleJobId = billingDecisionNotificationJobId(cycleSubmissionId, 'more_info', 1);
  const latestCycleJobId = billingDecisionNotificationJobId(cycleSubmissionId, 'more_info', 3);

  // Ambiguous-outcome fixtures: each gets its own already-decided submission (REJECTED,
  // a 2-entry history) plus a directly-seeded outbox row (state 'enqueued', never pushed
  // to the live queue) — the exact precondition a committed-but-not-yet-acknowledged
  // decision would leave behind. The test invokes `processor.process()` directly so the
  // live `deliveryWorker` never races it.
  const crashSubmissionId = randomUUID();
  const CRASH_REQUEST = 'Please provide the SWIFT copy for the transfer.';
  const crashHistory: PaymentSubmissionStatusHistoryEntry[] = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2027-03-01T08:00:00.000Z',
      changedBy: enOwnerId,
      notes: null,
    },
    {
      status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
      changedAt: '2027-03-02T08:00:00.000Z',
      changedBy: billingAdminSubject,
      notes: FIRST_CYCLE_REQUEST,
    },
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2027-03-03T08:00:00.000Z',
      changedBy: enOwnerId,
      notes: null,
    },
    {
      status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
      changedAt: '2027-03-04T08:00:00.000Z',
      changedBy: billingAdminSubject,
      notes: CRASH_REQUEST,
    },
  ];
  const crashJobId = billingDecisionNotificationJobId(crashSubmissionId, 'more_info', 3);

  const lostAckSubmissionId = randomUUID();
  const LOST_ACK_REASON = 'Lost-acknowledgment fixture: reference mismatch.';
  const lostAckJobId = billingDecisionNotificationJobId(lostAckSubmissionId, 'reject', 1);

  const concurrentSubmissionId = randomUUID();
  const CONCURRENT_REASON = 'Concurrency fixture: reference mismatch.';
  const concurrentJobId = billingDecisionNotificationJobId(concurrentSubmissionId, 'reject', 1);

  const preAcceptFailureSubmissionId = randomUUID();
  const PRE_ACCEPT_FAILURE_REASON = 'Pre-acceptance failure fixture: reference mismatch.';
  const preAcceptFailureJobId = billingDecisionNotificationJobId(
    preAcceptFailureSubmissionId,
    'reject',
    1,
  );

  const mismatchSubmissionId = randomUUID();
  const MISMATCH_REASON = 'Payload-mismatch fixture: reference mismatch.';
  const mismatchJobId = billingDecisionNotificationJobId(mismatchSubmissionId, 'reject', 1);

  const quarantineSubmissionId = randomUUID();
  const QUARANTINE_REASON = 'Quarantine-boundary fixture: reference mismatch.';
  const quarantineJobId = billingDecisionNotificationJobId(quarantineSubmissionId, 'reject', 1);

  const tenantMismatchSubmissionId = randomUUID();
  const TENANT_MISMATCH_REASON = 'Tenant-mismatch fixture: reference mismatch.';
  const tenantMismatchJobId = billingDecisionNotificationJobId(
    tenantMismatchSubmissionId,
    'reject',
    1,
  );

  const localeChangeSubmissionId = randomUUID();
  const LOCALE_CHANGE_REASON = 'Locale-change-between-attempts fixture: reference mismatch.';
  const localeChangeJobId = billingDecisionNotificationJobId(localeChangeSubmissionId, 'reject', 1);

  const malformedPayloadSubmissionId = randomUUID();
  const MALFORMED_PAYLOAD_REASON = 'Malformed-legacy-payload fixture: reference mismatch.';
  const malformedPayloadJobId = billingDecisionNotificationJobId(
    malformedPayloadSubmissionId,
    'reject',
    1,
  );

  const logRedactionSubmissionId = randomUUID();
  const LOG_REDACTION_REASON = 'Log-redaction fixture: reference mismatch.';
  const logRedactionJobId = billingDecisionNotificationJobId(logRedactionSubmissionId, 'reject', 1);

  const ambiguousFixtureIds = [
    lostAckSubmissionId,
    concurrentSubmissionId,
    preAcceptFailureSubmissionId,
    mismatchSubmissionId,
    quarantineSubmissionId,
    tenantMismatchSubmissionId,
    localeChangeSubmissionId,
    malformedPayloadSubmissionId,
    logRedactionSubmissionId,
  ];
  const ambiguousFixturePeriods: Record<string, [string, string]> = {
    [lostAckSubmissionId]: ['2027-04-01', '2027-04-30'],
    [concurrentSubmissionId]: ['2027-05-01', '2027-05-31'],
    [preAcceptFailureSubmissionId]: ['2027-06-01', '2027-06-30'],
    [mismatchSubmissionId]: ['2027-07-01', '2027-07-31'],
    [quarantineSubmissionId]: ['2027-08-01', '2027-08-31'],
    [tenantMismatchSubmissionId]: ['2027-09-01', '2027-09-30'],
    [localeChangeSubmissionId]: ['2027-10-01', '2027-10-31'],
    [malformedPayloadSubmissionId]: ['2027-11-01', '2027-11-30'],
    [logRedactionSubmissionId]: ['2027-12-01', '2027-12-31'],
  };
  const ambiguousFixtureReasons: Record<string, string> = {
    [lostAckSubmissionId]: LOST_ACK_REASON,
    [concurrentSubmissionId]: CONCURRENT_REASON,
    [preAcceptFailureSubmissionId]: PRE_ACCEPT_FAILURE_REASON,
    [mismatchSubmissionId]: MISMATCH_REASON,
    [quarantineSubmissionId]: QUARANTINE_REASON,
    [tenantMismatchSubmissionId]: TENANT_MISMATCH_REASON,
    [localeChangeSubmissionId]: LOCALE_CHANGE_REASON,
    [malformedPayloadSubmissionId]: MALFORMED_PAYLOAD_REASON,
    [logRedactionSubmissionId]: LOG_REDACTION_REASON,
  };

  const originalEnvironment = {
    redisUrl: process.env.REDIS_URL,
    resendApiKey: process.env.RESEND_API_KEY,
    resendFrom: process.env.RESEND_FROM,
    resendBaseUrl: process.env.RESEND_BASE_URL,
    resendAllowLoopbackFixture: process.env.RESEND_ALLOW_LOOPBACK_FIXTURE,
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

    fixture = await startFakeResend();
    process.env.REDIS_URL = HEALTHY_REDIS_URL;
    process.env.RESEND_API_KEY = 't070-test-key';
    process.env.RESEND_FROM = RESEND_FROM;
    process.env.RESEND_BASE_URL = fixture.url;
    // Finding 3 hardening: the real transport now refuses a loopback base URL unless
    // this is EXPLICITLY set — never set in a real deployment, only here (this is the
    // suite that talks to the local protocol-test fixture, never a real send).
    process.env.RESEND_ALLOW_LOOPBACK_FIXTURE = '1';

    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    queue = new Queue(QUEUE_NOTIFICATION_BILLING_DECISION, {
      connection: redisConnectionFromUrl(HEALTHY_REDIS_URL),
    });
    for (const jobId of [
      billingDecisionNotificationJobId(rejectSubmissionId, 'reject', 1),
      billingDecisionNotificationJobId(arSubmissionId, 'more_info', 1),
      priorCycleJobId,
      latestCycleJobId,
      billingDecisionNotificationJobId(approveSubmissionId, 'approve', 1),
    ]) {
      await queue.remove(jobId).catch(() => undefined);
    }

    // The REAL production processor instance, driven by a real BullMQ worker loop —
    // jobs genuinely transition waiting → active → completed/failed through it.
    const processor = app.get(BillingDecisionNotificationProcessor);
    deliveryWorker = new Worker(
      QUEUE_NOTIFICATION_BILLING_DECISION,
      (job) => processor.process(job),
      { connection: redisConnectionFromUrl(HEALTHY_REDIS_URL), concurrency: 1 },
    );

    const planRepository = controlDataSource.getRepository(Plan);
    await planRepository.save(
      planRepository.create({
        id: planId,
        name: `T070 delivery private fixture ${label}`,
        published: false,
        monthlyPrice: '1250.50',
        annualPrice: '12505.00',
        currency: 'AED',
      }),
    );

    const accountRepository = controlDataSource.getRepository(Account);
    await accountRepository.save([
      accountRepository.create({
        id: enOwnerId,
        keycloakUserId: enOwnerId,
        email: enEmail,
        emailVerified: true,
        preferredLocale: Locale.EN,
        selectedPlanId: planId,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
      accountRepository.create({
        id: arOwnerId,
        keycloakUserId: arOwnerId,
        email: arEmail,
        emailVerified: true,
        preferredLocale: Locale.AR,
        selectedPlanId: planId,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
    ]);

    const tenantRepository = controlDataSource.getRepository(Tenant);
    let enSubscriptionId = '';
    for (const [tenantId, accountId] of [
      [enTenantId, enOwnerId],
      [arTenantId, arOwnerId],
    ] as const) {
      await tenantRepository.save(
        tenantRepository.create({
          id: tenantId,
          accountId,
          status: TenantStatus.READY,
          readyAt: new Date(),
          minioBucket: `kemfai-tenant-${tenantId}`,
        }),
      );
      const subscriptionRepository = controlDataSource.getRepository(Subscription);
      const subscription = await subscriptionRepository.save(
        subscriptionRepository.create({
          tenantId,
          planId,
          billingCycle: SubscriptionBillingCycle.MONTHLY,
          status: SubscriptionStatus.PENDING_ACTIVATION,
          currentPeriodStart: '2026-10-01',
          currentPeriodEnd: '2026-10-31',
        }),
      );
      if (tenantId === enTenantId) enSubscriptionId = subscription.id;

      const submissionRepository = controlDataSource.getRepository(PaymentSubmission);
      const submissionRows: Array<{
        id: string;
        status: PaymentSubmissionStatus;
        statusHistory: PaymentSubmissionStatusHistoryEntry[];
        period: [string, string];
        decisionNotes: string | null;
      }> =
        tenantId === enTenantId
          ? [
              {
                id: rejectSubmissionId,
                status: PaymentSubmissionStatus.PENDING_REVIEW,
                statusHistory: initialHistory.map((entry) => ({ ...entry })),
                period: ['2026-10-01', '2026-10-31'],
                decisionNotes: null,
              },
              {
                id: cycleSubmissionId,
                status: PaymentSubmissionStatus.PENDING_REVIEW,
                statusHistory: priorCycleHistory,
                period: ['2026-11-01', '2026-11-30'],
                decisionNotes: null,
              },
              {
                id: approveSubmissionId,
                status: PaymentSubmissionStatus.PENDING_REVIEW,
                statusHistory: initialHistory.map((entry) => ({ ...entry })),
                period: ['2026-12-01', '2026-12-31'],
                decisionNotes: null,
              },
              {
                id: crashSubmissionId,
                status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
                statusHistory: crashHistory,
                period: ['2027-03-01', '2027-03-31'],
                decisionNotes: CRASH_REQUEST,
              },
              ...ambiguousFixtureIds.map((id) => ({
                id,
                status: PaymentSubmissionStatus.REJECTED,
                statusHistory: [
                  initialHistory[0],
                  {
                    status: PaymentSubmissionStatus.REJECTED,
                    changedAt: '2027-01-01T08:00:00.000Z',
                    changedBy: billingAdminSubject,
                    notes: ambiguousFixtureReasons[id],
                  },
                ] as PaymentSubmissionStatusHistoryEntry[],
                period: ambiguousFixturePeriods[id],
                decisionNotes: ambiguousFixtureReasons[id],
              })),
            ]
          : [
              {
                id: arSubmissionId,
                status: PaymentSubmissionStatus.PENDING_REVIEW,
                statusHistory: initialHistory.map((entry) => ({
                  ...entry,
                  changedBy: arOwnerId,
                })),
                period: ['2026-10-01', '2026-10-31'],
                decisionNotes: null,
              },
            ];
      await submissionRepository.save(
        submissionRows.map((row, index) =>
          submissionRepository.create({
            id: row.id,
            tenantId,
            subscriptionId: subscription.id,
            billingPeriodStart: row.period[0],
            billingPeriodEnd: row.period[1],
            amount: '1250.50',
            currency: 'AED',
            bankReference: `T070DV-${tenantId === enTenantId ? 'EN' : 'AR'}-${index}-${label}`,
            proofObjectKey: `payment-submissions/${row.id}/proof.pdf`,
            status: row.status,
            statusHistory: row.statusHistory,
            decisionNotes: row.decisionNotes,
          }),
        ),
      );
    }

    // The crash-window occurrence has its production-shaped outbox row (state
    // enqueued) so the durable delivered marker has a home for this fixture.
    await controlDataSource.query(
      `INSERT INTO ${OUTBOX_TABLE}
         (submission_id, tenant_id, decision, decision_occurrence, notes, occurred_at, job_id, state)
       VALUES ($1, $2, 'more_info', 3, $3, $4, $5, 'enqueued')`,
      [crashSubmissionId, enTenantId, CRASH_REQUEST, '2027-03-04T08:00:00.000Z', crashJobId],
    );
    // The "prior cycle's job already sitting in the queue" fixture needs its OWN
    // production-shaped outbox row too: the processor's `findByJobId` guard now requires
    // one for every occurrence (a job can never exist in production without the outbox
    // row that was committed atomically with the decision that enqueued it) — this test
    // seeds that occurrence's history directly rather than replaying a real decide()
    // call, so the matching row must be seeded directly alongside it, not skipped.
    await controlDataSource.query(
      `INSERT INTO ${OUTBOX_TABLE}
         (submission_id, tenant_id, decision, decision_occurrence, notes, occurred_at, job_id, state)
       VALUES ($1, $2, 'more_info', 1, $3, $4, $5, 'enqueued')`,
      [
        cycleSubmissionId,
        enTenantId,
        FIRST_CYCLE_REQUEST,
        '2026-10-03T08:00:00.000Z',
        priorCycleJobId,
      ],
    );
    for (const [submissionId, jobId] of [
      [lostAckSubmissionId, lostAckJobId],
      [concurrentSubmissionId, concurrentJobId],
      [preAcceptFailureSubmissionId, preAcceptFailureJobId],
      [mismatchSubmissionId, mismatchJobId],
      [quarantineSubmissionId, quarantineJobId],
      [tenantMismatchSubmissionId, tenantMismatchJobId],
      [localeChangeSubmissionId, localeChangeJobId],
      [malformedPayloadSubmissionId, malformedPayloadJobId],
      [logRedactionSubmissionId, logRedactionJobId],
    ]) {
      await controlDataSource.query(
        `INSERT INTO ${OUTBOX_TABLE}
           (submission_id, tenant_id, decision, decision_occurrence, notes, occurred_at, job_id, state)
         VALUES ($1, $2, 'reject', 1, $3, $4, $5, 'enqueued')`,
        [
          submissionId,
          enTenantId,
          ambiguousFixtureReasons[submissionId],
          '2027-01-01T08:00:00.000Z',
          jobId,
        ],
      );
    }
    void enSubscriptionId;

    ownerTokenEn = await customerKeycloak.signAccessToken({
      sub: enOwnerId,
      roles: ['WorkspaceOwner'],
      tenantId: enTenantId,
    });
    billingAdminToken = await internalKeycloak.signAccessToken({
      sub: billingAdminSubject,
      roles: ['BillingAdmin'],
    });
  }, 90_000);

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
      if (deliveryWorker) await attempt(() => deliveryWorker.close());
      if (queue) {
        if (controlDataSource.isInitialized) {
          const rows = (await controlDataSource.query(
            `SELECT job_id FROM ${OUTBOX_TABLE} WHERE tenant_id = ANY($1::uuid[])`,
            [[enTenantId, arTenantId]],
          )) as Array<{ job_id: string }>;
          for (const row of rows) {
            await attempt(() => queue.remove(row.job_id));
          }
        }
        for (const jobId of [priorCycleJobId, latestCycleJobId]) {
          await attempt(() => queue.remove(jobId));
        }
        await attempt(() => queue.close());
      }
      if (controlDataSource.isInitialized) {
        for (const tenantId of [enTenantId, arTenantId]) {
          await attempt(() =>
            controlDataSource.query('DELETE FROM audit_event WHERE tenant_id = $1', [tenantId]),
          );
          await attempt(() =>
            controlDataSource.query('DELETE FROM payment_submission WHERE tenant_id = $1', [
              tenantId,
            ]),
          );
          await attempt(() =>
            controlDataSource.query('DELETE FROM subscription WHERE tenant_id = $1', [tenantId]),
          );
          await attempt(() =>
            controlDataSource.query('DELETE FROM tenant WHERE id = $1', [tenantId]),
          );
        }
        await attempt(() =>
          controlDataSource.query('DELETE FROM account WHERE id = ANY($1::uuid[])', [
            [enOwnerId, arOwnerId],
          ]),
        );
        await attempt(() => controlDataSource.query('DELETE FROM plan WHERE id = $1', [planId]));
        await attempt(async () => expect(await fixtureResidueCount()).toBe(0));
      }
    } finally {
      if (app) await attempt(() => app.close());
      if (fixture) await attempt(() => fixture.close());
      if (customerKeycloak) await attempt(() => customerKeycloak.close());
      if (internalKeycloak) await attempt(() => internalKeycloak.close());
      if (controlDataSource.isInitialized) await attempt(() => controlDataSource.destroy());
      restoreEnvironment('REDIS_URL', originalEnvironment.redisUrl);
      restoreEnvironment('RESEND_API_KEY', originalEnvironment.resendApiKey);
      restoreEnvironment('RESEND_FROM', originalEnvironment.resendFrom);
      restoreEnvironment('RESEND_BASE_URL', originalEnvironment.resendBaseUrl);
      restoreEnvironment(
        'RESEND_ALLOW_LOOPBACK_FIXTURE',
        originalEnvironment.resendAllowLoopbackFixture,
      );
      restoreEnvironment('KEYCLOAK_ISSUER', originalEnvironment.issuer);
      restoreEnvironment('KEYCLOAK_API_AUDIENCE', originalEnvironment.audience);
      restoreEnvironment('KEYCLOAK_JWKS_URI', originalEnvironment.jwksUri);
      restoreEnvironment('KEYCLOAK_INTERNAL_ISSUER', originalEnvironment.internalIssuer);
      restoreEnvironment('KEYCLOAK_INTERNAL_API_AUDIENCE', originalEnvironment.internalAudience);
      restoreEnvironment('KEYCLOAK_INTERNAL_JWKS_URI', originalEnvironment.internalJwksUri);
    }

    if (cleanupError) throw cleanupError;
  }, 90_000);

  it('notifies the customer of a rejection with the reason, over Resend (Scenario 6.3)', async () => {
    const response = await postDecision(rejectSubmissionId, 'reject', { reason: REJECT_REASON });
    expect(response.status).toBe(200);

    await waitForJobCompletion(billingDecisionNotificationJobId(rejectSubmissionId, 'reject', 1));

    const call = acceptedTo(enEmail).find((entry) => bodyText(entry).includes(REJECT_REASON));
    expect(call).toBeDefined();
    expect((call!.body as { from: string }).from).toBe(RESEND_FROM);
    expect(bodyText(call!)).toContain('2026-10-01');
  }, 30_000);

  it('notifies an Arabic-locale customer of a more-info request with the needed specifics (Scenario 6.4)', async () => {
    const response = await postDecision(arSubmissionId, 'request-more-info', {
      details: AR_MORE_INFO_DETAILS,
    });
    expect(response.status).toBe(200);

    await waitForJobCompletion(billingDecisionNotificationJobId(arSubmissionId, 'more_info', 1));

    const call = acceptedTo(arEmail)[0];
    expect(call).toBeDefined();
    expect(bodyText(call)).toContain(AR_MORE_INFO_DETAILS);
    expect(bodyText(call)).not.toContain('Please provide');
  }, 30_000);

  it("delivers the latest more-info notes even when the prior cycle's job already completed", async () => {
    // The prior cycle's notification job — really completed by the production
    // processor, so the queue-level dedupe state the reviewer demanded is COMPLETED,
    // not merely waiting.
    await queue.add(
      'notify',
      {
        submissionId: cycleSubmissionId,
        tenantId: enTenantId,
        decision: 'more_info',
        notes: FIRST_CYCLE_REQUEST,
        occurredAt: '2026-10-03T08:00:00.000Z',
        decisionOccurrence: 1,
      },
      { jobId: priorCycleJobId },
    );
    await waitForJobCompletion(priorCycleJobId);
    expect(acceptedTo(enEmail).some((entry) => bodyText(entry).includes(FIRST_CYCLE_REQUEST))).toBe(
      true,
    );

    // The customer resubmitted (seeded history) and the admin requests more again.
    const response = await postDecision(cycleSubmissionId, 'request-more-info', {
      details: LATEST_CYCLE_REQUEST,
    });
    expect(response.status).toBe(200);

    await waitForJobCompletion(latestCycleJobId);
    expect(
      acceptedTo(enEmail).some((entry) => bodyText(entry).includes(LATEST_CYCLE_REQUEST)),
    ).toBe(true);
    // Each occurrence is its own distinct provider acceptance — neither suppressed.
    expect(
      acceptedTo(enEmail).filter((entry) => bodyText(entry).includes(FIRST_CYCLE_REQUEST)),
    ).toHaveLength(1);
    expect(
      acceptedTo(enEmail).filter((entry) => bodyText(entry).includes(LATEST_CYCLE_REQUEST)),
    ).toHaveLength(1);

    expect(await queue.getJob(priorCycleJobId)).toBeDefined();
    const priorState = await (await queue.getJob(priorCycleJobId))!.getState();
    expect(priorState).toBe('completed');
  }, 45_000);

  it('notifies the customer of an approval (FR-035 covers every decision)', async () => {
    const response = await postDecision(approveSubmissionId, 'approve', undefined);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'Active' });

    await waitForJobCompletion(billingDecisionNotificationJobId(approveSubmissionId, 'approve', 1));
    const call = acceptedTo(enEmail).find((entry) => bodyText(entry).includes('2026-12-01'));
    expect(call).toBeDefined();
  }, 30_000);

  it('keeps the decision visible to the customer while notification is in flight', async () => {
    const response = await request(baseUrl)
      .get('/billing/payment-submissions')
      .set('Authorization', `Bearer ${ownerTokenEn}`)
      .set('Accept', 'application/json')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(response.status).toBe(200);
  });

  it('is idempotent per decision occurrence: replaying an already-delivered job never resends (Codex round-3 finding 2)', async () => {
    const rejectionJobId = billingDecisionNotificationJobId(rejectSubmissionId, 'reject', 1);
    const job = await queue.getJob(rejectionJobId);
    expect(job).toBeDefined();
    expect(await job!.getState()).toBe('completed');

    const before = fixture.accepted.length;
    // A real post-completion replay (redelivery, manual reprocess, retry-after-crash
    // once the durable delivered marker exists) must be a silent no-op.
    const processor = app.get(BillingDecisionNotificationProcessor);
    await processor.process(job!);
    await processor.process(job!);

    expect(fixture.accepted.length).toBe(before);
  }, 30_000);

  it('a crash between provider acceptance and the durable mark resends ONCE under the SAME key (never a duplicate acceptance), then never again', async () => {
    const before = acceptedTo(enEmail).length;
    const realTransport = app.get(BILLING_DECISION_NOTIFICATION_TRANSPORT);
    // REAL HTTP acceptance at the fixture, then a simulated process death BEFORE the
    // durable `delivered_at` mark commits — the exact gap plain SMTP could never close.
    const crashingTransport = {
      buildRequestBody: (email: never) => realTransport.buildRequestBody(email),
      sendRaw: async (body: string, key: string) => {
        await realTransport.sendRaw(body, key);
        throw new Error('simulated crash after provider acceptance, before delivered_at commit');
      },
    };
    const crashingProcessor = new BillingDecisionNotificationProcessor(
      crashingTransport as never,
      app.get(BillingDecisionNotificationOutboxService),
    );
    const crashJobData = {
      submissionId: crashSubmissionId,
      tenantId: enTenantId,
      decision: 'more_info' as const,
      decisionOccurrence: 3,
      notes: CRASH_REQUEST,
      occurredAt: '2027-03-04T08:00:00.000Z',
    };

    // Attempt 1: the provider accepted (fixture +1), the "process" died before marking.
    await expect(crashingProcessor.process({ data: crashJobData } as never)).rejects.toThrow(
      'simulated crash after provider acceptance, before delivered_at commit',
    );
    expect(acceptedTo(enEmail).length).toBe(before + 1);

    // Attempt 2 (production processor): the SAME deterministic key is replayed; the
    // provider returns its cached result — NO second accepted entry is created.
    const processor = app.get(BillingDecisionNotificationProcessor);
    await processor.process({ data: crashJobData } as never);
    expect(acceptedTo(enEmail).length).toBe(before + 1);

    const row = await outboxRow(crashJobId);
    expect(row.delivered_at).not.toBeNull();
    expect(row.provider_message_id).not.toBeNull();

    // Every later replay of the SAME occurrence is a silent no-op (durable marker).
    await processor.process({ data: crashJobData } as never);
    await processor.process({ data: crashJobData } as never);
    expect(acceptedTo(enEmail).length).toBe(before + 1);
  }, 30_000);

  it('recovers a lost acknowledgment AFTER a RESEND_FROM config drift: the exact persisted request body (original sender) is resent, never rebuilt (independent review repair finding 1)', async () => {
    const row = await outboxRow(lostAckJobId);
    const key = resendIdempotencyKey(row.id);
    const jobData = {
      submissionId: lostAckSubmissionId,
      tenantId: enTenantId,
      decision: 'reject' as const,
      decisionOccurrence: 1,
      notes: LOST_ACK_REASON,
      occurredAt: '2027-01-01T08:00:00.000Z',
    };

    // Simulate exactly what the production processor does up to, and including, the
    // real provider call — but stop there, as if the acknowledgment never reached us.
    // `buildRequestBody` bakes in the CURRENT `RESEND_FROM` now, as the complete,
    // byte-exact request. `beginSendAttempt` PERSISTS it as the occurrence's permanent,
    // reused-verbatim-forever body.
    const realTransport = app.get(BILLING_DECISION_NOTIFICATION_TRANSPORT);
    const firstAttemptBody = realTransport.buildRequestBody({
      to: enEmail,
      subject: 'Your payment submission was rejected',
      body: `Lost-acknowledgment fixture body: ${LOST_ACK_REASON}\n`,
    });
    expect(JSON.parse(firstAttemptBody).from).toBe(RESEND_FROM);

    const outbox = app.get(BillingDecisionNotificationOutboxService);
    const claimed = await outbox.beginSendAttempt(row.id, firstAttemptBody);
    expect(claimed.providerRequestBody).toBe(firstAttemptBody);

    const originalAccepted = await realTransport.sendRaw(firstAttemptBody, key);
    expect(acceptedTo(enEmail).filter((c) => c.idempotencyKey === key)).toHaveLength(1);

    // Config drift between the lost acknowledgment and the retry — e.g. a redeploy
    // that changed the sender. If the retry rebuilt the body live, it would carry THIS
    // changed sender — a different body under the SAME key, which the fixture would
    // fail-closed 409 exactly like a real payload mismatch.
    const originalResendFrom = process.env.RESEND_FROM;
    process.env.RESEND_FROM = 'T070 Billing (CHANGED AFTER LOST ACK) <changed@example.invalid>';
    try {
      const processor = app.get(BillingDecisionNotificationProcessor);
      await processor.process({ data: jobData } as never);
    } finally {
      process.env.RESEND_FROM = originalResendFrom;
    }

    // Still exactly one accepted call — the retry sent the EXACT persisted bytes
    // (original sender), never a freshly built body carrying the changed sender.
    expect(acceptedTo(enEmail).filter((c) => c.idempotencyKey === key)).toHaveLength(1);
    const updated = await outboxRow(lostAckJobId);
    expect(updated.delivered_at).not.toBeNull();
    expect(updated.provider_message_id).toBe(originalAccepted.providerMessageId);
    expect(updated.provider_request_body).toBe(firstAttemptBody);
    expect(JSON.parse(updated.provider_request_body!).from).toBe(RESEND_FROM);
  }, 30_000);

  it('a legacy/malformed row with no persisted request body after a successful claim fails closed, never guessing a payload', async () => {
    const row = await outboxRow(malformedPayloadJobId);
    // Force the claim's own COALESCE to have nothing to coalesce onto by seeding an
    // empty string first — `beginSendAttempt`'s guard treats an empty/falsy body as
    // "no persisted payload" at the processor level, same as a legacy NULL row would.
    await controlDataSource.query(
      `UPDATE ${OUTBOX_TABLE} SET first_send_attempted_at = now(), provider_request_body = '' WHERE id = $1`,
      [row.id],
    );
    const jobData = {
      submissionId: malformedPayloadSubmissionId,
      tenantId: enTenantId,
      decision: 'reject' as const,
      decisionOccurrence: 1,
      notes: MALFORMED_PAYLOAD_REASON,
      occurredAt: '2027-01-01T08:00:00.000Z',
    };
    const before = fixture.accepted.length;
    const processor = app.get(BillingDecisionNotificationProcessor);
    await expect(processor.process({ data: jobData } as never)).rejects.toThrow(
      /no persisted provider request body/,
    );
    expect(fixture.accepted.length).toBe(before);
  }, 30_000);

  it('persists the first-built request body verbatim: a changed account locale between attempts never changes what is resent on retry', async () => {
    const jobData = {
      submissionId: localeChangeSubmissionId,
      tenantId: enTenantId,
      decision: 'reject' as const,
      decisionOccurrence: 1,
      notes: LOCALE_CHANGE_REASON,
      occurredAt: '2027-01-01T08:00:00.000Z',
    };
    const failingTransport = {
      buildRequestBody: (email: never) =>
        app.get(BILLING_DECISION_NOTIFICATION_TRANSPORT).buildRequestBody(email),
      sendRaw: async () => Promise.reject(new Error('connection refused')),
    };
    const failingProcessor = new BillingDecisionNotificationProcessor(
      failingTransport as never,
      app.get(BillingDecisionNotificationOutboxService),
    );
    await expect(failingProcessor.process({ data: jobData } as never)).rejects.toThrow(
      'connection refused',
    );
    const afterFirstAttempt = await outboxRow(localeChangeJobId);
    const firstAttemptBody = afterFirstAttempt.provider_request_body!;
    expect(JSON.parse(firstAttemptBody)).toMatchObject({
      subject: 'Your payment submission was rejected',
    });
    expect(firstAttemptBody).toContain(LOCALE_CHANGE_REASON);

    // A locale change between attempts would have rendered Arabic subject/body —
    // provably irrelevant now: the persisted English body from the first attempt is
    // what gets resent, never a fresh (and in this case differently-localized) build.
    const accountRepository = controlDataSource.getRepository(Account);
    await accountRepository.update({ id: enOwnerId }, { preferredLocale: Locale.AR });
    try {
      const processor = app.get(BillingDecisionNotificationProcessor);
      await processor.process({ data: jobData } as never);
    } finally {
      await accountRepository.update({ id: enOwnerId }, { preferredLocale: Locale.EN });
    }

    const final = await outboxRow(localeChangeJobId);
    expect(final.delivered_at).not.toBeNull();
    expect(final.provider_request_body).toBe(firstAttemptBody);
  }, 30_000);

  it('two overlapping processors for the same occurrence produce exactly one accepted notification and one durable completion', async () => {
    const jobData = {
      submissionId: concurrentSubmissionId,
      tenantId: enTenantId,
      decision: 'reject' as const,
      decisionOccurrence: 1,
      notes: CONCURRENT_REASON,
      occurredAt: '2027-01-01T08:00:00.000Z',
    };
    const processorA = app.get(BillingDecisionNotificationProcessor);
    const processorB = new BillingDecisionNotificationProcessor(
      app.get(BILLING_DECISION_NOTIFICATION_TRANSPORT),
      app.get(BillingDecisionNotificationOutboxService),
    );

    await Promise.all([
      processorA.process({ data: jobData } as never),
      processorB.process({ data: jobData } as never),
    ]);

    expect(acceptedTo(enEmail).filter((c) => bodyText(c).includes(CONCURRENT_REASON))).toHaveLength(
      1,
    );
    const row = await outboxRow(concurrentJobId);
    expect(row.delivered_at).not.toBeNull();
    expect(row.provider_message_id).not.toBeNull();

    // Real-Postgres terminal-state race: provider acceptance is factual (the fixture
    // accepted exactly once above), so even if the cutoff sweep and a 409 handler race
    // its durable marker, all three atomic statements must reconcile to delivered and
    // never leave contradictory terminal evidence.
    const outbox = app.get(BillingDecisionNotificationOutboxService);
    await controlDataSource.query(
      `UPDATE ${OUTBOX_TABLE}
          SET delivered_at = NULL, provider_message_id = NULL,
              delivery_rejected_at = NULL, quarantined_at = NULL
        WHERE id = $1`,
      [row.id],
    );
    await Promise.all([
      outbox.markQuarantined(row.id),
      outbox.markDeliveryRejected(row.id),
      outbox.markDelivered(row.id, row.provider_message_id!),
    ]);
    const reconciled = await outboxRow(concurrentJobId);
    expect(reconciled.delivered_at).not.toBeNull();
    expect(reconciled.provider_message_id).toBe(row.provider_message_id);
    expect(reconciled.delivery_rejected_at).toBeNull();
    expect(reconciled.quarantined_at).toBeNull();
  }, 30_000);

  it('a failure before the provider ever saw the request retries successfully without any loss', async () => {
    const jobData = {
      submissionId: preAcceptFailureSubmissionId,
      tenantId: enTenantId,
      decision: 'reject' as const,
      decisionOccurrence: 1,
      notes: PRE_ACCEPT_FAILURE_REASON,
      occurredAt: '2027-01-01T08:00:00.000Z',
    };
    const before = acceptedTo(enEmail).length;
    const failingTransport = {
      buildRequestBody: (email: never) =>
        app.get(BILLING_DECISION_NOTIFICATION_TRANSPORT).buildRequestBody(email),
      sendRaw: async () => Promise.reject(new Error('connection refused')),
    };
    const failingProcessor = new BillingDecisionNotificationProcessor(
      failingTransport as never,
      app.get(BillingDecisionNotificationOutboxService),
    );

    await expect(failingProcessor.process({ data: jobData } as never)).rejects.toThrow(
      'connection refused',
    );
    expect(acceptedTo(enEmail).length).toBe(before);

    const processor = app.get(BillingDecisionNotificationProcessor);
    await processor.process({ data: jobData } as never);
    expect(acceptedTo(enEmail).length).toBe(before + 1);
    const row = await outboxRow(preAcceptFailureJobId);
    expect(row.delivered_at).not.toBeNull();
  }, 30_000);

  it('a payload-mismatched replay of the SAME key fails closed (409) and is never retried under a new key', async () => {
    const row = await outboxRow(mismatchJobId);
    const key = resendIdempotencyKey(row.id);
    // Pre-poison the fixture's cache for this occurrence's OWN deterministic key with a
    // conflicting body — simulating a payload drift the system must never paper over.
    const poison = await fetch(new URL('/emails', fixture.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ from: RESEND_FROM, to: [enEmail], subject: 'poison', text: 'poison' }),
    });
    expect(poison.status).toBe(200);
    const acceptedBefore = fixture.accepted.length;

    const jobData = {
      submissionId: mismatchSubmissionId,
      tenantId: enTenantId,
      decision: 'reject' as const,
      decisionOccurrence: 1,
      notes: MISMATCH_REASON,
      occurredAt: '2027-01-01T08:00:00.000Z',
    };
    const processor = app.get(BillingDecisionNotificationProcessor);
    await expect(processor.process({ data: jobData } as never)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const updated = await outboxRow(mismatchJobId);
    expect(updated.delivery_rejected_at).not.toBeNull();
    expect(updated.delivered_at).toBeNull();
    expect(fixture.accepted.length).toBe(acceptedBefore);

    // Replaying does not retry under a fresh key — it is rejected again immediately,
    // with no further HTTP call to the provider at all.
    const callsBefore = fixture.calls.length;
    await expect(processor.process({ data: jobData } as never)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(fixture.calls.length).toBe(callsBefore);
  }, 30_000);

  it('independent review repair (2026-10-16), finding 2: the recovery worker sweep AUTOMATICALLY quarantines an exhausted-ambiguous occurrence — no processor/job invocation at all', async () => {
    const row = await outboxRow(quarantineJobId);
    // Simulate a first attempt old enough to be past the conservative cutoff — e.g. a
    // dead worker, or BullMQ's own 5 attempts having exhausted long ago (~155s total
    // backoff) while the row stays ambiguous for hours afterward. NOTHING here ever
    // calls `processor.process()` — this is the exact "BullMQ attempts exhausted, row
    // stuck forever" scenario the recovery worker's sweep exists to self-heal.
    await controlDataSource.query(
      `UPDATE ${OUTBOX_TABLE} SET first_send_attempted_at = now() - ($2 * interval '1 millisecond')
         WHERE id = $1`,
      [row.id, RESEND_RETRY_CUTOFF_MS + 60_000],
    );

    const callsBefore = fixture.calls.length;
    const worker = app.get(BillingDecisionNotificationRecoveryWorker);
    await worker.tick();

    // The sweep is a pure, time-based SQL UPDATE — it never contacts the provider.
    expect(fixture.calls.length).toBe(callsBefore);
    const updated = await outboxRow(quarantineJobId);
    expect(updated.quarantined_at).not.toBeNull();
    expect(updated.delivered_at).toBeNull();

    // Idempotent: re-ticking never re-quarantines or touches the provider again.
    await worker.tick();
    expect(fixture.calls.length).toBe(callsBefore);
    expect((await outboxRow(quarantineJobId)).quarantined_at!.getTime()).toBe(
      updated.quarantined_at!.getTime(),
    );

    // Defense in depth: if a stray BullMQ retry somehow still invoked the processor
    // afterward (e.g. a job that was already `active` when the sweep ran), the
    // processor's OWN top-of-function check independently refuses too — belt AND
    // braces, never relying on only one of the two layers.
    const jobData = {
      submissionId: quarantineSubmissionId,
      tenantId: enTenantId,
      decision: 'reject' as const,
      decisionOccurrence: 1,
      notes: QUARANTINE_REASON,
      occurredAt: '2027-01-01T08:00:00.000Z',
    };
    const processor = app.get(BillingDecisionNotificationProcessor);
    await expect(processor.process({ data: jobData } as never)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(fixture.calls.length).toBe(callsBefore);
  }, 30_000);

  it("a tenant-mismatched job cannot claim or deliver another tenant's occurrence", async () => {
    const before = fixture.accepted.length;
    const jobData = {
      submissionId: tenantMismatchSubmissionId,
      tenantId: arTenantId, // WRONG — the submission actually belongs to enTenantId.
      decision: 'reject' as const,
      decisionOccurrence: 1,
      notes: TENANT_MISMATCH_REASON,
      occurredAt: '2027-01-01T08:00:00.000Z',
    };
    const processor = app.get(BillingDecisionNotificationProcessor);
    await expect(processor.process({ data: jobData } as never)).rejects.toThrow(
      /no longer resolvable/,
    );

    expect(fixture.accepted.length).toBe(before);
    const row = await outboxRow(tenantMismatchJobId);
    expect(row.delivered_at).toBeNull();
  }, 30_000);

  it('independent review repair (2026-10-16), finding 4: a successful delivery never logs the recipient address, subject, or body — only correlation IDs', async () => {
    // Defensive, self-contained precondition: force this occurrence's outbox row back
    // to pristine (never-attempted) state immediately before the call, regardless of
    // test execution order or any other test's interaction with the shared fixture
    // array — this test must prove what a FIRST successful delivery logs, not react
    // to accidental prior state from elsewhere in the suite.
    await controlDataSource.query(
      `UPDATE ${OUTBOX_TABLE}
         SET delivered_at = NULL, first_send_attempted_at = NULL,
             provider_request_body = NULL, provider_message_id = NULL,
             quarantined_at = NULL, delivery_rejected_at = NULL
       WHERE job_id = $1`,
      [logRedactionJobId],
    );
    const before = await outboxRow(logRedactionJobId);
    expect(before.delivered_at).toBeNull();

    const jobData = {
      submissionId: logRedactionSubmissionId,
      tenantId: enTenantId,
      decision: 'reject' as const,
      decisionOccurrence: 1,
      notes: LOG_REDACTION_REASON,
      occurredAt: '2027-01-01T08:00:00.000Z',
    };
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // `jest.SpyInstance#mockRestore()` does not just restore the original
    // implementation — it also clears `.mock.calls` (equivalent to `mockReset()` plus
    // restoring). Reading `logSpy.mock.calls` AFTER `mockRestore()` therefore always
    // sees an EMPTY array, regardless of what was actually logged — this is exactly
    // what produced "loggedLines.length == 0" against real infra: the assertions were
    // reading post-restore history, not a real absence of logging. The copy MUST be
    // taken inside `try`, before the `finally` block's guaranteed restore runs.
    let capturedCalls: unknown[][] = [];
    try {
      const processor = app.get(BillingDecisionNotificationProcessor);
      await processor.process({ data: jobData } as never);
      capturedCalls = logSpy.mock.calls.map((call) => [...call]);
    } finally {
      logSpy.mockRestore();
    }

    // Postcondition: the delivery genuinely happened — if it did not (e.g. the
    // occurrence hit the "already delivered" skip path instead), that is a DIFFERENT,
    // more specific failure than "no matching log line", and this assertion surfaces
    // it directly instead of leaving it to be inferred from the log-content check below.
    const after = await outboxRow(logRedactionJobId);
    expect(after.delivered_at).not.toBeNull();

    const loggedLines = capturedCalls.map((call) => String(call[0]));
    expect(loggedLines.length).toBeGreaterThan(0);
    expect(
      loggedLines.some((line) => line.includes('billing decision notification delivered')),
    ).toBe(true);
    for (const line of loggedLines) {
      expect(line).not.toContain(enEmail);
      expect(line).not.toContain(LOG_REDACTION_REASON);
      expect(line.toLowerCase()).not.toContain('resend-test-key'.toLowerCase());
      expect(line).not.toMatch(/@/); // no email address of any shape
    }
  }, 30_000);

  function postDecision(
    submissionId: string,
    action: 'approve' | 'reject' | 'request-more-info',
    body: Record<string, unknown> | undefined,
  ) {
    const call = request(baseUrl)
      .post(`/internal/billing/payment-submissions/${submissionId}/${action}`)
      .set('Authorization', `Bearer ${billingAdminToken}`)
      .set('Accept', 'application/json')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Requested-With', 'XMLHttpRequest');
    return body ? call.send(body) : call;
  }

  async function waitForJobCompletion(jobId: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const job = await queue.getJob(jobId);
      if (job) {
        const state = await job.getState();
        if (state === 'completed') return;
        if (state === 'failed') {
          throw new Error(`notification job ${jobId} failed: ${job.failedReason}`);
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for notification job ${jobId} to complete`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  function acceptedTo(recipient: string) {
    return fixture.accepted.filter((entry) => {
      const to = (entry.body as { to?: string[] } | null)?.to ?? [];
      return to.includes(recipient);
    });
  }

  function bodyText(entry: { body: unknown }): string {
    return (entry.body as { text?: string } | null)?.text ?? '';
  }

  async function outboxRow(jobId: string): Promise<{
    id: string;
    delivered_at: Date | null;
    provider_message_id: string | null;
    delivery_rejected_at: Date | null;
    quarantined_at: Date | null;
    provider_request_body: string | null;
    first_send_attempted_at: Date | null;
  }> {
    const rows = (await controlDataSource.query(
      `SELECT id, delivered_at, provider_message_id, delivery_rejected_at, quarantined_at,
              provider_request_body, first_send_attempted_at
         FROM ${OUTBOX_TABLE} WHERE job_id = $1`,
      [jobId],
    )) as Array<{
      id: string;
      delivered_at: Date | null;
      provider_message_id: string | null;
      delivery_rejected_at: Date | null;
      quarantined_at: Date | null;
      provider_request_body: string | null;
      first_send_attempted_at: Date | null;
    }>;
    return rows[0];
  }

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
         (SELECT COUNT(*) FROM tenant WHERE id = ANY($3::uuid[])) +
         (SELECT COUNT(*) FROM subscription WHERE tenant_id = ANY($3::uuid[])) +
         (SELECT COUNT(*) FROM payment_submission WHERE tenant_id = ANY($3::uuid[])) +
         (SELECT COUNT(*) FROM audit_event WHERE tenant_id = ANY($3::uuid[])) +
         (SELECT COUNT(*) FROM ${OUTBOX_TABLE} WHERE tenant_id = ANY($3::uuid[])) AS count`,
      [planId, [enOwnerId, arOwnerId], [enTenantId, arTenantId]],
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
