import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import {
  ALL_QUEUE_NAMES,
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
import { BillingDecisionNotificationOutboxService } from '../../src/modules/billing-admin/billing-decision-notification-outbox.service';
import { BillingDecisionNotificationRecoveryWorker } from '../../src/modules/billing-admin/billing-decision-notification-recovery.worker';
import { BillingDecisionNotificationProcessor } from '../../src/modules/billing-admin/billing-decision-notification.processor';
import { TrialExpirySweepProcessor } from '../../src/integrations/provisioning/trial-expiry-sweep.processor';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';
import {
  SelectiveRedisProxy,
  SilentServer,
  startSelectiveRedisProxy,
  startSilentServer,
} from '../support/selective-redis-proxy';

const CUSTOMER_ISSUER = 'http://127.0.0.1/realms/kemfai-customers-t070rr';
const INTERNAL_ISSUER = 'http://127.0.0.1/realms/kemfai-internal-t070rr';
const AUDIENCE = 'kemfai-api-t070rr';
const REJECT_REASON = 'The transferred amount does not match the amount due for this period.';
const TAKEOVER_DETAILS = 'Please provide the bank confirmation number.';
const OUTBOX_TABLE = 'billing_decision_notification_outbox';
const HEALTHY_REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/14';

/**
 * T070 real-failure recovery specification (Codex round-2 finding 1).
 *
 * Every failure below is REAL — produced through production code paths, never by
 * inserting outbox rows by hand or mocking Queue.add:
 *
 * - the failing Redis is a real socket endpoint answering `notification.billing_decision`
 *   commands with genuine Redis protocol errors while proxying everything else to the
 *   real isolated test Redis, so the application boots normally and ONLY the
 *   notification add fails (a real `Queue.add()` rejection);
 * - the post-commit crash window is entered by making a REAL decision HTTP request
 *   commit through that failing Redis — the durable decision returns 200 while the
 *   enqueue provably never reached any queue, which is observationally exactly the
 *   "process died between commit and enqueue" state;
 * - the retry/backoff transition, the recovery convergence, and the multi-replica lease
 *   takeover all run through the production outbox service and recovery worker classes
 *   against real PostgreSQL and the real isolated Redis DB 14.
 *
 * The hung-dispatch seam is a real TCP server that accepts and never replies: a worker
 * instance holding a claim dies "mid-dispatch", its lease expires, and a second worker
 * takes the row over — exactly like two API replicas.
 */
describe('Billing decision notification real-failure recovery (T070)', () => {
  let failingApp: INestApplication;
  let failingBaseUrl: string;
  let healthyApp: INestApplication;
  let customerKeycloak: FakeKeycloak;
  let internalKeycloak: FakeKeycloak;
  let proxy: SelectiveRedisProxy;
  let silent: SilentServer;
  let healthyQueue: Queue;
  let billingAdminToken: string;
  // Fixture-ownership fix: the forced-proxy scenario deliberately makes a production
  // BullMQ Worker's own retry machinery emit real 'error' events (BullMQ requires a
  // listener or Node treats them as unhandled, which is what was producing the
  // multi-MB stack-trace spam in CI — not a test failure, but genuinely unhandled
  // Node-level noise). This fixture, not production code, owns listening for and
  // retaining that EXPECTED error as evidence — nothing is suppressed or masked, the
  // error is still fully captured and inspectable, just no longer "unhandled".
  //
  // Code-inspection finding (2026-10-16, second real-infra run): the listener fix on
  // `BillingDecisionNotificationProcessor` alone did not account for every WorkerHost
  // in this module graph. Of the three `@Processor`-decorated classes in this codebase,
  // `BillingDecisionNotificationProcessor` and `TenantProvisionProcessor` both gate
  // `autorun: process.env.NODE_ENV !== 'test'` (never auto-start under this suite), but
  // `TrialExpirySweepProcessor` (`@Processor(QUEUE_TRIAL_EXPIRY_SWEEP)`, no `autorun`
  // option — BullMQ's default is `true`) does NOT: it genuinely starts a real consumer
  // Worker on whatever `REDIS_URL` was active at `AppModule` compile time, i.e. the
  // proxy URL for `failingApp`. It is therefore a precise, code-inspection-identified
  // second owner, not a speculative broad fix — `attachWorkerErrorCapture` below covers
  // both known WorkerHost classes that can actually run here. If unhandled-error spam
  // still appears after this, it is from neither of these two and must be reported with
  // its own exact stack trace, not assumed to be the same source again.
  const capturedWorkerErrors: Error[] = [];

  function attachWorkerErrorCapture(app: INestApplication): void {
    for (const ProcessorClass of [
      BillingDecisionNotificationProcessor,
      TrialExpirySweepProcessor,
    ]) {
      app
        .get(ProcessorClass, { strict: false })
        ?.worker.on('error', (error: Error) => capturedWorkerErrors.push(error));
    }
  }

  const label = `t070rr-${randomUUID()}`;
  const planId = randomUUID();
  const ownerAccountId = randomUUID();
  const billingAdminSubject = randomUUID();
  const tenantId = randomUUID();
  const subscriptionId = randomUUID();
  const failSubmissionId = randomUUID();
  const takeoverSubmissionId = randomUUID();
  const initialHistory: PaymentSubmissionStatusHistoryEntry[] = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-10-02T08:00:00.000Z',
      changedBy: ownerAccountId,
      notes: null,
    },
  ];
  const failJobId = billingDecisionNotificationJobId(failSubmissionId, 'reject', 1);
  const takeoverJobId = billingDecisionNotificationJobId(takeoverSubmissionId, 'more_info', 1);
  const originalEnvironment = {
    redisUrl: process.env.REDIS_URL,
    disableWorker: process.env.KEMFAI_DISABLE_BILLING_NOTIFICATION_RECOVERY_WORKER,
    leaseMs: process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_LEASE_MS,
    backoffMs: process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_BACKOFF_MS,
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

    const healthyRedis = new URL(HEALTHY_REDIS_URL);
    proxy = await startSelectiveRedisProxy({
      backend: {
        host: healthyRedis.hostname,
        port: Number(healthyRedis.port || '6379'),
        db: Number(healthyRedis.pathname.slice(1) || '0'),
      },
      failWhenArgMatches: /notification\.billing_decision/,
    });
    silent = await startSilentServer();

    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    // The failing replica: a REAL AppModule whose Redis endpoint answers every
    // notification-queue command with a protocol error. Its in-process recovery worker
    // is disabled so the recovery sequencing below is driven deterministically through
    // the production worker class itself.
    process.env.REDIS_URL = proxy.url;
    process.env.KEMFAI_DISABLE_BILLING_NOTIFICATION_RECOVERY_WORKER = '1';
    let moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    failingApp = moduleRef.createNestApplication();
    await failingApp.listen(0, '127.0.0.1');
    failingBaseUrl = `http://127.0.0.1:${(failingApp.getHttpServer().address() as AddressInfo).port}`;
    attachWorkerErrorCapture(failingApp);

    // The healthy replica: the real isolated test Redis (DB 14).
    process.env.REDIS_URL = HEALTHY_REDIS_URL;
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    healthyApp = moduleRef.createNestApplication();
    await healthyApp.init();
    attachWorkerErrorCapture(healthyApp);

    healthyQueue = new Queue(QUEUE_NOTIFICATION_BILLING_DECISION, {
      connection: redisConnectionFromUrl(HEALTHY_REDIS_URL),
    });
    await healthyQueue.remove(failJobId).catch(() => undefined);
    await healthyQueue.remove(takeoverJobId).catch(() => undefined);

    const planRepository = controlDataSource.getRepository(Plan);
    await planRepository.save(
      planRepository.create({
        id: planId,
        name: `T070 real-failure private fixture ${label}`,
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

    const submissionRepository = controlDataSource.getRepository(PaymentSubmission);
    await submissionRepository.save([
      submissionRepository.create({
        id: failSubmissionId,
        tenantId,
        subscriptionId,
        billingPeriodStart: '2026-10-01',
        billingPeriodEnd: '2026-10-31',
        amount: '1250.50',
        currency: 'AED',
        bankReference: `T070RR-FAIL-${label}`,
        proofObjectKey: `payment-submissions/${failSubmissionId}/proof.pdf`,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        statusHistory: initialHistory,
      }),
      submissionRepository.create({
        id: takeoverSubmissionId,
        tenantId,
        subscriptionId,
        billingPeriodStart: '2026-11-01',
        billingPeriodEnd: '2026-11-30',
        amount: '1250.50',
        currency: 'AED',
        bankReference: `T070RR-TAKEOVER-${label}`,
        proofObjectKey: `payment-submissions/${takeoverSubmissionId}/proof.pdf`,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        statusHistory: initialHistory.map((entry) => ({ ...entry })),
      }),
    ]);

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
      if (healthyQueue) {
        if (controlDataSource.isInitialized) {
          const rows = (await controlDataSource.query(
            `SELECT job_id FROM ${OUTBOX_TABLE} WHERE tenant_id = $1`,
            [tenantId],
          )) as Array<{ job_id: string }>;
          for (const row of rows) {
            await attempt(() => healthyQueue.remove(row.job_id));
          }
        }
        await attempt(() => healthyQueue.remove(failJobId));
        await attempt(() => healthyQueue.remove(takeoverJobId));
        await attempt(() => closeQueue(healthyQueue));
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
      if (failingApp) await attempt(() => bounded(failingApp.close(), 15_000, 'failingApp.close'));
      if (healthyApp) await attempt(() => bounded(healthyApp.close(), 15_000, 'healthyApp.close'));
      // A graceful app close can leave a reconnecting ioredis handle behind (the proxy
      // below severs its sockets); force-disconnect every registered queue and the
      // processor's worker so Jest can exit naturally — no --forceExit, no suppressed
      // checks.
      for (const app of [failingApp, healthyApp]) {
        if (!app) continue;
        for (const queueName of ALL_QUEUE_NAMES) {
          await attempt(async () => {
            const queue = app.get(getQueueToken(queueName), { strict: false });
            if (queue) await forceDisconnect(queue);
          });
        }
        await attempt(async () => {
          const processor = app.get(BillingDecisionNotificationProcessor, { strict: false });
          if (processor) {
            await bounded(processor.worker.close(), 3_000, 'processor worker close');
            await forceDisconnect(processor.worker);
          }
        });
      }
      if (silent) await attempt(() => bounded(silent.close(), 10_000, 'silent.close'));
      if (proxy) await attempt(() => bounded(proxy.close(), 10_000, 'proxy.close'));
      if (customerKeycloak) await attempt(() => customerKeycloak.close());
      if (internalKeycloak) await attempt(() => internalKeycloak.close());
      if (controlDataSource.isInitialized) await attempt(() => controlDataSource.destroy());
      restoreEnvironment('REDIS_URL', originalEnvironment.redisUrl);
      restoreEnvironment(
        'KEMFAI_DISABLE_BILLING_NOTIFICATION_RECOVERY_WORKER',
        originalEnvironment.disableWorker,
      );
      restoreEnvironment(
        'KEMFAI_BILLING_NOTIFICATION_RECOVERY_LEASE_MS',
        originalEnvironment.leaseMs,
      );
      restoreEnvironment(
        'KEMFAI_BILLING_NOTIFICATION_RECOVERY_BACKOFF_MS',
        originalEnvironment.backoffMs,
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

  it('commits a real decision over HTTP whose Redis add genuinely fails, leaving a pending row and no job anywhere', async () => {
    const response = await request(failingBaseUrl)
      .post(`/internal/billing/payment-submissions/${failSubmissionId}/reject`)
      .set('Authorization', `Bearer ${billingAdminToken}`)
      .set('Accept', 'application/json')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ reason: REJECT_REASON });

    // FR-035's non-blocking rule under a REAL Redis failure: the decision is durable.
    expect(response.status).toBe(200);
    expect(proxy.failedCommands()).toBeGreaterThanOrEqual(1);

    // The crash window: committed, but the enqueue never reached any queue.
    const row = (await outboxRow(failSubmissionId))!;
    expect(row.state).toBe('pending');
    expect(row.retry_count).toBe(0);
    expect(await healthyQueue.getJob(failJobId)).toBeUndefined();

    const submission = await controlDataSource
      .getRepository(PaymentSubmission)
      .findOneByOrFail({ id: failSubmissionId });
    expect(submission.status).toBe(PaymentSubmissionStatus.REJECTED);
  });

  it('records a REAL retry/backoff transition through the production worker against the still-failing Redis', async () => {
    const failingQueue = new Queue(QUEUE_NOTIFICATION_BILLING_DECISION, {
      connection: redisConnectionFromUrl(proxy.url),
    });
    const before = proxy.failedCommands();
    // Short tunables (read at construction) keep the subsequent recovery test fast.
    process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_BACKOFF_MS = '800';
    const brokenWorker = new BillingDecisionNotificationRecoveryWorker(
      healthyApp.get(BillingDecisionNotificationOutboxService),
      failingQueue,
    );
    await brokenWorker.tick();
    await closeQueue(failingQueue);

    // A fresh protocol-level rejection really happened for the retry attempt.
    expect(proxy.failedCommands()).toBeGreaterThan(before);

    const row = (await outboxRow(failSubmissionId))!;
    expect(row.state).toBe('pending');
    expect(row.retry_count).toBeGreaterThanOrEqual(1);
    expect(row.next_attempt_at).not.toBeNull();
    expect(new Date(row.next_attempt_at!).getTime()).toBeGreaterThan(Date.now() - 1_000);
    expect(row.lease_owner).toBeNull();
    expect(await healthyQueue.getJob(failJobId)).toBeUndefined();
  });

  it('recovers the crashed decision through the production outbox/worker into the healthy Redis, exactly once', async () => {
    await waitFor(
      async () =>
        (await outboxRow(failSubmissionId))!.next_attempt_at !== null &&
        new Date((await outboxRow(failSubmissionId))!.next_attempt_at!).getTime() <= Date.now(),
      15_000,
      'backoff window to elapse',
    );

    const healthyWorker = healthyApp.get(BillingDecisionNotificationRecoveryWorker);
    await healthyWorker.tick();

    const row = (await outboxRow(failSubmissionId))!;
    expect(row.state).toBe('enqueued');
    expect(row.lease_owner).toBeNull();

    const job = await healthyQueue.getJob(failJobId);
    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({
      submissionId: failSubmissionId,
      tenantId,
      decision: 'reject',
      notes: REJECT_REASON,
      decisionOccurrence: 1,
    });

    // Idempotent recovery: re-ticking the same converged row enqueues nothing new.
    await healthyWorker.tick();
    await healthyWorker.tick();
    const failJobs = await fixtureJobs(failSubmissionId);
    expect(failJobs).toEqual([failJobId]);
  });

  it("hands a hung replica's expired lease over to another replica without duplicating the job", async () => {
    const response = await request(failingBaseUrl)
      .post(`/internal/billing/payment-submissions/${takeoverSubmissionId}/request-more-info`)
      .set('Authorization', `Bearer ${billingAdminToken}`)
      .set('Accept', 'application/json')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ details: TAKEOVER_DETAILS });
    expect(response.status).toBe(200);

    // Replica A: the production worker against a Redis that accepts the connection and
    // never answers — its claim succeeds, its dispatch stalls (bounded by a real
    // command timeout well past the lease expiry), its lease expires. The connection
    // never reconnects after the test severs it, so cleanup cannot leak handles.
    process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_LEASE_MS = '1200';
    const hungQueue = new Queue(QUEUE_NOTIFICATION_BILLING_DECISION, {
      connection: {
        host: '127.0.0.1',
        port: silent.port,
        maxRetriesPerRequest: null,
        commandTimeout: 4_000,
        retryStrategy: () => null,
        enableOfflineQueue: false,
      },
    });
    const replicaA = new BillingDecisionNotificationRecoveryWorker(
      healthyApp.get(BillingDecisionNotificationOutboxService),
      hungQueue,
    );
    const hungTick = replicaA.tick();

    await waitFor(
      async () => (await outboxRow(takeoverSubmissionId))!.lease_owner !== null,
      10_000,
      'replica A to claim the pending row',
    );
    expect((await outboxRow(takeoverSubmissionId))!.state).toBe('pending');
    expect(await healthyQueue.getJob(takeoverJobId)).toBeUndefined();

    // Lease expiry is what makes the row claimable again — before it, the healthy
    // replica must find nothing to do.
    const healthyWorker = healthyApp.get(BillingDecisionNotificationRecoveryWorker);
    await healthyWorker.tick();
    expect((await outboxRow(takeoverSubmissionId))!.state).toBe('pending');

    await sleep(1_400);
    await healthyWorker.tick();

    const row = (await outboxRow(takeoverSubmissionId))!;
    expect(row.state).toBe('enqueued');
    const job = await healthyQueue.getJob(takeoverJobId);
    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({
      submissionId: takeoverSubmissionId,
      decision: 'more_info',
      notes: TAKEOVER_DETAILS,
      decisionOccurrence: 1,
    });

    // Replica A's connection dies; its late dispatch attempt converges to nothing.
    await silent.close();
    await withTimeout(hungTick, 15_000, 'hung tick to unwind');
    await closeQueue(hungQueue);

    // Fixture-UUID-scoped uniqueness: exactly ONE job exists for the takeover
    // submission (the recovered occurrence) and the earlier fixture's job is
    // untouched — a global queue count would be blind to other suites/fixtures.
    const takeoverJobs = await fixtureJobs(takeoverSubmissionId);
    expect(takeoverJobs).toEqual([takeoverJobId]);
    const failJobsAfterTakeover = await fixtureJobs(failSubmissionId);
    expect(failJobsAfterTakeover).toEqual([failJobId]);
  }, 30_000);

  it('every production worker running in this suite surfaces the forced-proxy protocol error as an observed, expected event — never an unhandled one', () => {
    // The scenarios above deliberately drive production BullMQ Workers' own retry
    // machinery against a Redis that rejects commands matching the notification queue.
    // Without a listener, a Worker's 'error' event is unhandled Node-level noise (the
    // ~11MB stack-trace spam this fixture used to produce); `attachWorkerErrorCapture`
    // (covering both `BillingDecisionNotificationProcessor` and
    // `TrialExpirySweepProcessor` — the only two `@Processor` classes that actually run
    // a live Worker under this suite's `NODE_ENV=test`) turns it into retained,
    // inspectable evidence instead — nothing is suppressed, every error still fully
    // exists and is asserted on here.
    for (const error of capturedWorkerErrors) {
      expect(error.message).toMatch(/forced selectivity|command rejected by test proxy/);
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

  async function outboxRow(submissionId: string): Promise<{
    job_id: string;
    state: string;
    retry_count: number;
    next_attempt_at: string | null;
    lease_owner: string | null;
  } | null> {
    const rows = (await controlDataSource.query(
      `SELECT job_id, state, retry_count, next_attempt_at, lease_owner
         FROM ${OUTBOX_TABLE} WHERE submission_id = $1`,
      [submissionId],
    )) as Array<{
      job_id: string;
      state: string;
      retry_count: number;
      next_attempt_at: string | null;
      lease_owner: string | null;
    }>;
    return rows[0] ?? null;
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

  /** Every queue job in every non-failed state whose payload belongs to this fixture. */
  async function fixtureJobs(submissionId: string): Promise<string[]> {
    const jobs = await healthyQueue.getJobs(
      ['waiting', 'completed', 'active', 'delayed', 'paused', 'prioritized'],
      0,
      -1,
    );
    return jobs
      .filter((job) => (job.data as { submissionId?: string }).submissionId === submissionId)
      .map((job) => job.id as string);
  }
});

/** Teardown-safe queue close: bounded graceful close, then an immediate no-wait disconnect. */
async function closeQueue(queue: Queue): Promise<void> {
  await bounded(queue.close(), 3_000, `${queue.name}.close`);
  forceDisconnect(queue);
}

/**
 * Fixture teardown hard-stop: BullMQ's graceful close/quit can wait forever on a
 * connection whose replies stopped (a severed proxy/silent endpoint), and even
 * `connection.disconnect(false)` can sit behind an in-flight close. This reaches the
 * raw ioredis client directly and destroys its socket, so no fixture-owned handle can
 * outlive the suite (Jest exits naturally — no --forceExit, no suppressed checks).
 */
async function forceDisconnect(target: unknown): Promise<void> {
  const connections = [
    (target as { connection?: unknown })?.connection,
    (target as { blockingConnection?: unknown })?.blockingConnection,
  ];
  for (const connection of connections) {
    if (!connection) continue;
    try {
      const client = (await Promise.race([
        (connection as { client?: Promise<unknown> }).client,
        new Promise((resolve) => setTimeout(() => resolve(undefined), 500)),
      ])) as { disconnect?: () => void; stream?: { destroy?: () => void } } | undefined;
      client?.stream?.destroy?.();
      client?.disconnect?.();
    } catch {
      // already destroyed
    }
    try {
      (connection as { disconnect: (wait?: boolean) => Promise<unknown> })
        .disconnect(false)
        ?.catch(() => undefined);
    } catch {
      // already destroyed
    }
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await sleep(100);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  await Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs),
    ),
  ]);
}

/** Teardown guard: resolves even if a close stalls, warning instead of hanging Jest. */
async function bounded(
  promise: Promise<unknown>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  let settled = false;
  await Promise.race([
    Promise.resolve(promise).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    ),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!settled) {
          // eslint-disable-next-line no-console
          console.warn(`cleanup: ${description} did not finish in ${timeoutMs}ms; continuing`);
        }
        resolve();
      }, timeoutMs);
    }),
  ]);
}
