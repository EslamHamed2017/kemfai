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
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import { AuditService } from '../../src/modules/audit/audit.service';
import { BillingAdminService } from '../../src/modules/billing-admin/billing-admin.service';
import { BillingDecisionNotificationRecoveryWorker } from '../../src/modules/billing-admin/billing-decision-notification-recovery.worker';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

const CUSTOMER_ISSUER = 'http://127.0.0.1/realms/kemfai-customers-t070d';
const INTERNAL_ISSUER = 'http://127.0.0.1/realms/kemfai-internal-t070d';
const AUDIENCE = 'kemfai-api-t070d';
const CRASH_REJECT_REASON = 'Beneficiary name does not match the account holder.';
const LATEST_MORE_INFO_REQUEST = 'Please also provide the bank confirmation number.';
const FIRST_MORE_INFO_REQUEST = 'Please provide the transfer receipt.';
const RACE_REASON = 'Amount does not match the amount due.';
const RACE_DETAILS = 'Please provide a SWIFT copy.';
const OUTBOX_TABLE = 'billing_decision_notification_outbox';

/**
 * T070 durability integration specification (Codex review findings 1–3).
 *
 * Boots the production AppModule against real PostgreSQL and the real Redis-backed
 * `notification.billing_decision` queue — nothing about the decision routes, the
 * outbox persistence, or the recovery worker is mocked. It proves the three durability
 * properties the reviewer found missing:
 *
 * 1. a decision whose enqueue never happened (Redis-add failure or process crash
 *    between commit and enqueue) leaves a PENDING outbox row that the registered
 *    recovery worker re-enqueues without any further HTTP request;
 * 2. a repeated more-info cycle enqueues its own occurrence-keyed job with the latest
 *    notes even when the prior cycle's job is still sitting in the queue;
 * 3. approvals notify too (FR-035), with the outbox row committed atomically inside the
 *    T069 activation transaction — one write, no activation split.
 *
 * Plus the reject-vs-more_info race (exactly one decision, one outbox row, one job) and
 * the audit-rollback guarantee (a failed in-transaction audit append rolls the outbox
 * row back with the decision, so an uncommitted decision can never notify).
 */
describe('Billing decision notification durability (T070)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let customerKeycloak: FakeKeycloak;
  let internalKeycloak: FakeKeycloak;
  let notificationQueue: Queue;
  let billingAdminToken: string;

  const label = `t070d-${randomUUID()}`;
  const planId = randomUUID();
  const ownerAccountId = randomUUID();
  const billingAdminSubject = randomUUID();
  const tenantId = randomUUID();
  const subscriptionId = randomUUID();
  const crashSubmissionId = randomUUID();
  const cycleSubmissionId = randomUUID();
  const raceSubmissionId = randomUUID();
  const approveSubmissionId = randomUUID();
  const auditRollbackSubmissionId = randomUUID();
  const crashJobId = billingDecisionNotificationJobId(crashSubmissionId, 'reject', 1);
  const priorCycleJobId = billingDecisionNotificationJobId(cycleSubmissionId, 'more_info', 1);
  const initialHistory: PaymentSubmissionStatusHistoryEntry[] = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-10-02T08:00:00.000Z',
      changedBy: ownerAccountId,
      notes: null,
    },
  ];
  const priorCycleHistory: PaymentSubmissionStatusHistoryEntry[] = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-10-02T08:00:00.000Z',
      changedBy: ownerAccountId,
      notes: null,
    },
    {
      status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
      changedAt: '2026-10-03T08:00:00.000Z',
      changedBy: billingAdminSubject,
      notes: FIRST_MORE_INFO_REQUEST,
    },
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-10-04T08:00:00.000Z',
      changedBy: ownerAccountId,
      notes: null,
    },
  ];
  const crashHistory: PaymentSubmissionStatusHistoryEntry[] = [
    initialHistory[0],
    {
      status: PaymentSubmissionStatus.REJECTED,
      changedAt: '2026-10-05T08:00:00.000Z',
      changedBy: billingAdminSubject,
      notes: CRASH_REJECT_REASON,
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
    await notificationQueue.remove(crashJobId).catch(() => undefined);
    await notificationQueue.remove(priorCycleJobId).catch(() => undefined);

    const planRepository = controlDataSource.getRepository(Plan);
    await planRepository.save(
      planRepository.create({
        id: planId,
        name: `T070 durability private fixture ${label}`,
        published: false,
        monthlyPrice: '1250.50',
        annualPrice: '12505.00',
        currency: 'AED',
      }),
    );

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
        currentPeriodStart: '2026-10-01',
        currentPeriodEnd: '2026-10-31',
      }),
    );

    const submissionRows = [
      {
        id: crashSubmissionId,
        status: PaymentSubmissionStatus.REJECTED,
        statusHistory: crashHistory,
        decisionNotes: CRASH_REJECT_REASON,
        reviewedAt: new Date('2026-10-05T08:00:00.000Z'),
      },
      {
        id: cycleSubmissionId,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        statusHistory: priorCycleHistory,
        decisionNotes: null,
        reviewedAt: null,
      },
      {
        id: raceSubmissionId,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        statusHistory: initialHistory.map((entry) => ({ ...entry })),
        decisionNotes: null,
        reviewedAt: null,
      },
      {
        id: approveSubmissionId,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        statusHistory: initialHistory.map((entry) => ({ ...entry })),
        decisionNotes: null,
        reviewedAt: null,
      },
      {
        id: auditRollbackSubmissionId,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        statusHistory: initialHistory.map((entry) => ({ ...entry })),
        decisionNotes: null,
        reviewedAt: null,
      },
    ];
    // One distinct billing period per submission (uq_payment_submission_unresolved_period
    // allows at most one unresolved submission per tenant/subscription/period).
    const submissionPeriods: Record<string, [string, string]> = {
      [crashSubmissionId]: ['2026-10-01', '2026-10-31'],
      [cycleSubmissionId]: ['2026-11-01', '2026-11-30'],
      [raceSubmissionId]: ['2026-12-01', '2026-12-31'],
      [approveSubmissionId]: ['2027-01-01', '2027-01-31'],
      [auditRollbackSubmissionId]: ['2027-02-01', '2027-02-28'],
    };
    const submissionRepository = controlDataSource.getRepository(PaymentSubmission);
    await submissionRepository.save(
      submissionRows.map((row, index) => {
        const [periodStart, periodEnd] = submissionPeriods[row.id];
        return submissionRepository.create({
          ...row,
          tenantId,
          subscriptionId,
          billingPeriodStart: periodStart,
          billingPeriodEnd: periodEnd,
          amount: '1250.50',
          currency: 'AED',
          bankReference: `T070D-${index}-${label}`,
          proofObjectKey: `payment-submissions/${row.id}/proof.pdf`,
        });
      }),
    );

    // Finding 1 fixture: the crash. The rejection below COMMITTED durably (status,
    // history, audit, outbox row) but the process died before the Redis enqueue —
    // seeded here exactly as production would have persisted it.
    await controlDataSource.query(
      `INSERT INTO ${OUTBOX_TABLE}
         (submission_id, tenant_id, decision, decision_occurrence, notes, occurred_at, job_id)
       VALUES ($1, $2, 'reject', 1, $3, $4, $5)`,
      [crashSubmissionId, tenantId, CRASH_REJECT_REASON, '2026-10-05T08:00:00.000Z', crashJobId],
    );

    // Finding 2 fixture: the prior cycle's job is ALREADY in the queue under the
    // first occurrence's key — the exact collision precondition the reviewer described.
    await notificationQueue.add(
      'notify',
      {
        submissionId: cycleSubmissionId,
        tenantId,
        decision: 'more_info',
        notes: FIRST_MORE_INFO_REQUEST,
        occurredAt: '2026-10-03T08:00:00.000Z',
      },
      { jobId: priorCycleJobId },
    );

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
        // Remove every job this suite created: the outbox rows enumerate the
        // occurrence-keyed ids; the prior-cycle job was seeded directly.
        if (controlDataSource.isInitialized) {
          const rows = (await controlDataSource.query(
            `SELECT job_id FROM ${OUTBOX_TABLE} WHERE tenant_id = $1`,
            [tenantId],
          )) as Array<{ job_id: string }>;
          for (const row of rows) {
            await attempt(() => notificationQueue.remove(row.job_id));
          }
        }
        await attempt(() => notificationQueue.remove(priorCycleJobId));
        await attempt(() => notificationQueue.remove(crashJobId));
        await attempt(() => notificationQueue.close());
      }
      if (controlDataSource.isInitialized) {
        await attempt(() =>
          controlDataSource.query('DELETE FROM audit_event WHERE tenant_id = $1', [tenantId]),
        );
        await attempt(() =>
          controlDataSource.query('DELETE FROM payment_submission WHERE tenant_id = $1', [
            tenantId,
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

  it('recovers a decision that committed without its enqueue (crash / Redis-add failure)', async () => {
    const worker = app.get(BillingDecisionNotificationRecoveryWorker);
    await worker.tick();

    const job = await notificationQueue.getJob(crashJobId);
    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({
      submissionId: crashSubmissionId,
      tenantId,
      decision: 'reject',
      notes: CRASH_REJECT_REASON,
    });

    const rows = await outboxRows(crashSubmissionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('enqueued');
    expect(rows[0].retry_count).toBeGreaterThanOrEqual(1);

    // Recovery is idempotent: re-ticking changes nothing (the unique job_id keeps the
    // enqueue exactly-once at the queue, and an enqueued row is terminal).
    await worker.tick();
    expect(await notificationQueue.getJob(crashJobId)).toBeDefined();
    expect((await outboxRows(crashSubmissionId))[0].state).toBe('enqueued');
  });

  it('enqueues the latest more-info notes as a distinct occurrence job despite the prior cycle job in the queue', async () => {
    const response = await request(baseUrl)
      .post(`/internal/billing/payment-submissions/${cycleSubmissionId}/request-more-info`)
      .set('Authorization', `Bearer ${billingAdminToken}`)
      .set('Accept', 'application/json')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ details: LATEST_MORE_INFO_REQUEST });

    expect(response.status).toBe(200);

    const latestJobId = billingDecisionNotificationJobId(cycleSubmissionId, 'more_info', 3);
    const latestJob = await notificationQueue.getJob(latestJobId);
    expect(latestJob).toBeDefined();
    expect(latestJob?.data).toMatchObject({
      submissionId: cycleSubmissionId,
      tenantId,
      decision: 'more_info',
      notes: LATEST_MORE_INFO_REQUEST,
    });

    // The prior cycle's job is untouched and still present — both notifications exist,
    // neither suppressed the other (FR-035: every decision notifies).
    const priorJob = await notificationQueue.getJob(priorCycleJobId);
    expect(priorJob).toBeDefined();
    expect(priorJob?.data).toMatchObject({ notes: FIRST_MORE_INFO_REQUEST });

    // Only the NEW decision wrote an outbox row — the seeded prior-cycle job was a
    // queue-level collision precondition, not a row this suite's decisions created.
    const rows = await outboxRows(cycleSubmissionId);
    expect(rows.map((row) => row.job_id)).toEqual([latestJobId]);
    expect(rows[0].state).toBe('enqueued');
  });

  it('allows exactly one of a concurrent reject vs more-info race, with exactly one notification', async () => {
    const [reject, moreInfo] = await Promise.all([
      request(baseUrl)
        .post(`/internal/billing/payment-submissions/${raceSubmissionId}/reject`)
        .set('Authorization', `Bearer ${billingAdminToken}`)
        .set('Origin', 'http://127.0.0.1')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ reason: RACE_REASON }),
      request(baseUrl)
        .post(`/internal/billing/payment-submissions/${raceSubmissionId}/request-more-info`)
        .set('Authorization', `Bearer ${billingAdminToken}`)
        .set('Origin', 'http://127.0.0.1')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ details: RACE_DETAILS }),
    ]);
    expect([reject.status, moreInfo.status].sort((a, b) => a - b)).toEqual([200, 409]);

    const rows = await outboxRows(raceSubmissionId);
    expect(rows).toHaveLength(1);
    const job = await notificationQueue.getJob(rows[0].job_id);
    expect(job).toBeDefined();

    const decided = await controlDataSource.query(
      'SELECT COUNT(*)::int AS count FROM audit_event WHERE tenant_id = $1 AND subject_id = $2',
      [tenantId, raceSubmissionId],
    );
    expect((decided as Array<{ count: number }>)[0].count).toBe(1);
  });

  it('notifies the customer of approvals too, atomically with the T069 activation (FR-035)', async () => {
    const response = await request(baseUrl)
      .post(`/internal/billing/payment-submissions/${approveSubmissionId}/approve`)
      .set('Authorization', `Bearer ${billingAdminToken}`)
      .set('Accept', 'application/json')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Requested-With', 'XMLHttpRequest');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      submissionId: approveSubmissionId,
      status: 'Active',
    });

    // T069 activation identity/atomicity is preserved: subscription active, both audit
    // events, reviewed_by Account FK stays null (internal-realm doctrine).
    const subscription = await controlDataSource
      .getRepository(Subscription)
      .findOneByOrFail({ id: subscriptionId });
    expect(subscription.status).toBe(SubscriptionStatus.ACTIVE);

    const submission = await controlDataSource
      .getRepository(PaymentSubmission)
      .findOneByOrFail({ id: approveSubmissionId });
    expect(submission.status).toBe(PaymentSubmissionStatus.APPROVED);
    expect(submission.reviewedBy).toBeNull();

    const actions = (
      (await controlDataSource.query(
        `SELECT action FROM audit_event
          WHERE tenant_id = $1
            AND (subject_id = $2 OR subject_id = $3)
          ORDER BY action`,
        [tenantId, approveSubmissionId, subscriptionId],
      )) as Array<{ action: string }>
    ).map((row) => row.action);
    expect(actions).toEqual([
      'billing.payment_submission.decided',
      'billing.subscription.activated',
    ]);

    // Finding 3: the approval notification exists — its own outbox row, enqueued.
    const rows = await outboxRows(approveSubmissionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('enqueued');
    expect(rows[0].decision).toBe('approve');
    const job = await notificationQueue.getJob(rows[0].job_id);
    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({
      submissionId: approveSubmissionId,
      tenantId,
      decision: 'approve',
      notes: null,
    });
  });

  it('rolls the outbox row back with the decision when the in-transaction audit append fails', async () => {
    const audit = app.get(AuditService);
    const billingAdmin = app.get(BillingAdminService);
    const failingAppend = jest
      .spyOn(audit, 'recordBillingPaymentSubmissionDecided')
      .mockImplementation(() => {
        throw new Error('audit store unavailable');
      });

    try {
      await expect(
        billingAdmin.reject(auditRollbackSubmissionId, billingAdminSubject, RACE_REASON),
      ).rejects.toThrow('audit store unavailable');

      const submission = await controlDataSource
        .getRepository(PaymentSubmission)
        .findOneByOrFail({ id: auditRollbackSubmissionId });
      expect(submission.status).toBe(PaymentSubmissionStatus.PENDING_REVIEW);
      expect(submission.decisionNotes).toBeNull();
      expect(submission.statusHistory).toHaveLength(1);

      expect(await outboxRows(auditRollbackSubmissionId)).toHaveLength(0);
      const auditRows = await controlDataSource.query(
        'SELECT COUNT(*)::int AS count FROM audit_event WHERE tenant_id = $1 AND subject_id = $2',
        [tenantId, auditRollbackSubmissionId],
      );
      expect((auditRows as Array<{ count: number }>)[0].count).toBe(0);
    } finally {
      failingAppend.mockRestore();
    }
  });

  function configureAuthRealms(): void {
    process.env.KEYCLOAK_ISSUER = CUSTOMER_ISSUER;
    process.env.KEYCLOAK_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_JWKS_URI = customerKeycloak.jwksUri;
    process.env.KEYCLOAK_INTERNAL_ISSUER = INTERNAL_ISSUER;
    process.env.KEYCLOAK_INTERNAL_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_INTERNAL_JWKS_URI = internalKeycloak.jwksUri;
  }

  async function outboxRows(
    submissionId: string,
  ): Promise<Array<{ job_id: string; state: string; decision: string; retry_count: number }>> {
    return (await controlDataSource.query(
      `SELECT job_id, state, decision, retry_count FROM ${OUTBOX_TABLE} WHERE submission_id = $1`,
      [submissionId],
    )) as Array<{ job_id: string; state: string; decision: string; retry_count: number }>;
  }

  async function fixtureResidueCount(): Promise<number> {
    const rows = (await controlDataSource.query(
      `SELECT
         (SELECT COUNT(*) FROM plan WHERE id = $1) +
         (SELECT COUNT(*) FROM account WHERE id = $2) +
         (SELECT COUNT(*) FROM tenant WHERE id = $3) +
         (SELECT COUNT(*) FROM subscription WHERE id = $4) +
         (SELECT COUNT(*) FROM payment_submission WHERE tenant_id = $3) +
         (SELECT COUNT(*) FROM audit_event WHERE tenant_id = $3) +
         (SELECT COUNT(*) FROM ${OUTBOX_TABLE} WHERE tenant_id = $3) AS count`,
      [planId, ownerAccountId, tenantId, subscriptionId],
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
