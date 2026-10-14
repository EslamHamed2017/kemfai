import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue, Worker } from 'bullmq';
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
import { BillingDecisionNotificationProcessor } from '../../src/modules/billing-admin/billing-decision-notification.processor';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';
import { RecordedMail, SmtpSink, startSmtpSink } from '../support/smtp-sink';

const CUSTOMER_ISSUER = 'http://127.0.0.1/realms/kemfai-customers-t070dv';
const INTERNAL_ISSUER = 'http://127.0.0.1/realms/kemfai-internal-t070dv';
const AUDIENCE = 'kemfai-api-t070dv';
const REJECT_REASON = 'The transferred amount does not match the amount due for this period.';
const AR_MORE_INFO_DETAILS = 'يرجى توفير رقم تأكيد التحويل البنكي.';
const FIRST_CYCLE_REQUEST = 'Please provide the transfer receipt.';
const LATEST_CYCLE_REQUEST = 'Please also provide the bank statement for the period.';
const OUTBOX_TABLE = 'billing_decision_notification_outbox';
const HEALTHY_REDIS_URL = 'redis://localhost:6379/14';
const SMTP_FROM = 'T070 Billing <t070-billing@example.invalid>';

/**
 * T070 delivery specification (Codex round-2 finding 2) — FR-035 / Acceptance
 * Scenarios 6.3/6.4 require the CUSTOMER TO BE NOTIFIED, not merely a queue handoff.
 *
 * This suite boots the production AppModule with SMTP_URL pointed at a local, real
 * ESMTP sink (fixture-owned destination, *.example.invalid recipients only — no external
 * send is possible) and consumes the `notification.billing_decision` queue with a real
 * BullMQ Worker whose handler is the app's own production processor instance. Nothing
 * about the decision routes, outbox, processor, or SMTP transport is mocked: a green
 * assertion here means a real wire-level delivery happened end-to-end, and a completed
 * job state means the production processor really ran and succeeded.
 */
describe('Billing decision customer notification delivery, FR-035 (T070)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let customerKeycloak: FakeKeycloak;
  let internalKeycloak: FakeKeycloak;
  let sink: SmtpSink;
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
  const originalEnvironment = {
    redisUrl: process.env.REDIS_URL,
    smtpUrl: process.env.SMTP_URL,
    smtpFrom: process.env.SMTP_FROM,
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

    sink = await startSmtpSink();
    process.env.REDIS_URL = HEALTHY_REDIS_URL;
    process.env.SMTP_URL = sink.url;
    process.env.SMTP_FROM = SMTP_FROM;

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

      const submissionRepository = controlDataSource.getRepository(PaymentSubmission);
      const submissionRows: Array<{
        id: string;
        status: PaymentSubmissionStatus;
        statusHistory: PaymentSubmissionStatusHistoryEntry[];
        period: [string, string];
        changedBy: string;
      }> =
        tenantId === enTenantId
          ? [
              {
                id: rejectSubmissionId,
                status: PaymentSubmissionStatus.PENDING_REVIEW,
                statusHistory: initialHistory.map((entry) => ({ ...entry })),
                period: ['2026-10-01', '2026-10-31'],
                changedBy: enOwnerId,
              },
              {
                id: cycleSubmissionId,
                status: PaymentSubmissionStatus.PENDING_REVIEW,
                statusHistory: priorCycleHistory,
                period: ['2026-11-01', '2026-11-30'],
                changedBy: enOwnerId,
              },
              {
                id: approveSubmissionId,
                status: PaymentSubmissionStatus.PENDING_REVIEW,
                statusHistory: initialHistory.map((entry) => ({ ...entry })),
                period: ['2026-12-01', '2026-12-31'],
                changedBy: enOwnerId,
              },
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
                changedBy: arOwnerId,
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
          }),
        ),
      );
    }

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
      if (sink) await attempt(() => sink.close());
      if (customerKeycloak) await attempt(() => customerKeycloak.close());
      if (internalKeycloak) await attempt(() => internalKeycloak.close());
      if (controlDataSource.isInitialized) await attempt(() => controlDataSource.destroy());
      restoreEnvironment('REDIS_URL', originalEnvironment.redisUrl);
      restoreEnvironment('SMTP_URL', originalEnvironment.smtpUrl);
      restoreEnvironment('SMTP_FROM', originalEnvironment.smtpFrom);
      restoreEnvironment('KEYCLOAK_ISSUER', originalEnvironment.issuer);
      restoreEnvironment('KEYCLOAK_API_AUDIENCE', originalEnvironment.audience);
      restoreEnvironment('KEYCLOAK_JWKS_URI', originalEnvironment.jwksUri);
      restoreEnvironment('KEYCLOAK_INTERNAL_ISSUER', originalEnvironment.internalIssuer);
      restoreEnvironment('KEYCLOAK_INTERNAL_API_AUDIENCE', originalEnvironment.internalAudience);
      restoreEnvironment('KEYCLOAK_INTERNAL_JWKS_URI', originalEnvironment.internalJwksUri);
    }

    if (cleanupError) throw cleanupError;
  }, 90_000);

  it('notifies the customer of a rejection with the reason, over real SMTP (Scenario 6.3)', async () => {
    const response = await postDecision(rejectSubmissionId, 'reject', { reason: REJECT_REASON });
    expect(response.status).toBe(200);

    const mails = await sink.waitFor(1);
    const rejectionMail = mails.find((mail) => mail.recipients.includes(enEmail));
    expect(rejectionMail).toBeDefined();
    expect(rejectionMail!.from).toBe('t070-billing@example.invalid');
    expect(mailBodyText(rejectionMail!)).toContain(REJECT_REASON);
    expect(mailBodyText(rejectionMail!)).toContain('2026-10-01');

    await waitForJobCompletion(billingDecisionNotificationJobId(rejectSubmissionId, 'reject', 1));
  }, 30_000);

  it('notifies an Arabic-locale customer of a more-info request with the needed specifics (Scenario 6.4)', async () => {
    const response = await postDecision(arSubmissionId, 'request-more-info', {
      details: AR_MORE_INFO_DETAILS,
    });
    expect(response.status).toBe(200);

    const mails = await sink.waitFor(2);
    const arabicMail = mails.find((mail) => mail.recipients.includes(arEmail));
    expect(arabicMail).toBeDefined();
    const body = mailBodyText(arabicMail!);
    expect(body).toContain(AR_MORE_INFO_DETAILS);
    expect(body).not.toContain('Please provide');

    await waitForJobCompletion(billingDecisionNotificationJobId(arSubmissionId, 'more_info', 1));
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
    const mailsAfterPrior = await sink.waitFor(3);
    expect(
      mailsAfterPrior.some(
        (mail) =>
          mail.recipients.includes(enEmail) && mailBodyText(mail).includes(FIRST_CYCLE_REQUEST),
      ),
    ).toBe(true);

    // The customer resubmitted (seeded history) and the admin requests more again.
    const response = await postDecision(cycleSubmissionId, 'request-more-info', {
      details: LATEST_CYCLE_REQUEST,
    });
    expect(response.status).toBe(200);

    const mails = await sink.waitFor(4);
    const latestMail = [...mails]
      .reverse()
      .find(
        (mail) =>
          mail.recipients.includes(enEmail) && mailBodyText(mail).includes(LATEST_CYCLE_REQUEST),
      );
    expect(latestMail).toBeDefined();

    await waitForJobCompletion(latestCycleJobId);
    expect(await queue.getJob(priorCycleJobId)).toBeDefined();
    const priorState = await (await queue.getJob(priorCycleJobId))!.getState();
    expect(priorState).toBe('completed');
  }, 45_000);

  it('notifies the customer of an approval (FR-035 covers every decision)', async () => {
    const response = await postDecision(approveSubmissionId, 'approve', undefined);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'Active' });

    const mails = await sink.waitFor(5);
    const approvalMail = mails.find(
      (mail) => mail.recipients.includes(enEmail) && mailBodyText(mail).includes('2026-12-01'),
    );
    expect(approvalMail).toBeDefined();
    await waitForJobCompletion(billingDecisionNotificationJobId(approveSubmissionId, 'approve', 1));
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

/** Decodes the RFC 5322 body the production transport sent (base64, UTF-8). */
function mailBodyText(mail: RecordedMail): string {
  const separator = mail.data.indexOf('\r\n\r\n');
  const body = separator >= 0 ? mail.data.slice(separator + 4) : mail.data;
  const withoutDots = body.replace(/\r\n\.\r\n$/, '');
  return Buffer.from(withoutDots.replace(/\r?\n/g, ''), 'base64').toString('utf8');
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
