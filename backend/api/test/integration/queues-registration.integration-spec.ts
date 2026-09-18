import { Queue } from 'bullmq';
import { redisConnectionFromUrl } from '../../src/common/queues/redis-connection';
import {
  QUEUE_EMAIL_SEND_VERIFICATION,
  QUEUE_SUPPORT_ACCESS_EXPIRY_SWEEP,
  QUEUE_TENANT_PROVISION,
  QUEUE_TRIAL_EXPIRY_SWEEP,
  SWEEP_JOB_NAME,
  SWEEP_REPEAT_INTERVAL_MS,
  billingDecisionNotificationJobId,
  emailVerificationJobId,
  tenantProvisionJobId,
} from '../../src/common/queues/queue-names';
import { QueueSchedulingService } from '../../src/common/queues/queue-scheduling.service';

/**
 * T021 acceptance test. Requires the docker-compose Redis instance (default
 * redis://localhost:6379, overridable via REDIS_URL) — the same convention the control-DB
 * integration suites use with CONTROL_DB_* env vars. Proves, against real Redis, that:
 *   1. all five contract queues are visible through BullMQ's inspection API,
 *   2. both 30s sweep schedules are registered exactly once and re-bootstrap is a no-op,
 *   3. the events.md job-id strategies really dedupe at the queue level.
 * Everything this suite creates in Redis is removed again in afterAll.
 */
describe('BullMQ queue registration (T021)', () => {
  const connection = redisConnectionFromUrl();
  const queues = [
    QUEUE_TENANT_PROVISION,
    QUEUE_EMAIL_SEND_VERIFICATION,
    'notification.billing_decision',
    QUEUE_SUPPORT_ACCESS_EXPIRY_SWEEP,
    QUEUE_TRIAL_EXPIRY_SWEEP,
  ].map((name) => new Queue(name, { connection }));

  const [tenantProvision, emailVerification, , supportAccessSweep, trialSweep] = queues;

  afterAll(async () => {
    for (const queue of queues) {
      const repeatables = await queue.getRepeatableJobs();
      for (const repeatable of repeatables) {
        await queue.removeRepeatableByKey(repeatable.key);
      }
      await queue.drain();
      await queue.close();
    }
  });

  it('makes all five contract queues visible via BullMQ inspection API', async () => {
    expect(queues.map((queue) => queue.name).sort()).toEqual(
      [
        QUEUE_TENANT_PROVISION,
        QUEUE_EMAIL_SEND_VERIFICATION,
        'notification.billing_decision',
        QUEUE_SUPPORT_ACCESS_EXPIRY_SWEEP,
        QUEUE_TRIAL_EXPIRY_SWEEP,
      ].sort(),
    );
    const sweepNames = new Set([QUEUE_SUPPORT_ACCESS_EXPIRY_SWEEP, QUEUE_TRIAL_EXPIRY_SWEEP]);
    for (const queue of queues) {
      const counts = await queue.getJobCounts();
      expect(counts).toBeDefined();
      if (sweepNames.has(queue.name)) {
        // A sweep queue may legitimately hold its single scheduled delayed job (BullMQ
        // materializes the next iteration of a repeatable when it is registered), but
        // nothing else: no per-entity jobs exist for a sweep by contract.
        const total = Object.values(counts).reduce((sum, n) => sum + (n as number), 0);
        expect(total).toBeLessThanOrEqual(1);
      } else {
        // No producer tasks exist yet, so the three per-entity queues must be empty.
        expect(Object.values(counts).every((n) => n === 0)).toBe(true);
      }
    }
  });

  it('registers each 30s sweep schedule exactly once, idempotently (events.md sweep rows)', async () => {
    const scheduler = new QueueSchedulingService(supportAccessSweep, trialSweep);

    await scheduler.ensureSweepSchedules();
    await scheduler.ensureSweepSchedules(); // re-bootstrap must not duplicate

    for (const sweep of [supportAccessSweep, trialSweep]) {
      const repeatables = await sweep.getRepeatableJobs();
      expect(repeatables).toHaveLength(1);
      expect(repeatables[0].name).toBe(SWEEP_JOB_NAME);
      expect(repeatables[0].every).toBe(String(SWEEP_REPEAT_INTERVAL_MS));
    }
  });

  it('dedupes tenant.provision by the bare account_id job id (unique job id strategy)', async () => {
    const accountId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await tenantProvision.add(
      'provision',
      { accountId },
      { jobId: tenantProvisionJobId(accountId) },
    );
    await tenantProvision.add(
      'provision',
      { accountId },
      { jobId: tenantProvisionJobId(accountId) },
    );

    const counts = await tenantProvision.getJobCounts();
    expect(counts.waiting).toBe(1);
    expect(await tenantProvision.getJob(tenantProvisionJobId(accountId))).toBeDefined();
  });

  it('keys email.send_verification jobs on account_id + token version (re-issue → distinct job)', async () => {
    const accountId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await emailVerification.add(
      'send',
      { accountId },
      { jobId: emailVerificationJobId(accountId, 'v1') },
    );
    await emailVerification.add(
      'send',
      { accountId },
      { jobId: emailVerificationJobId(accountId, 'v2') },
    );

    const counts = await emailVerification.getJobCounts();
    expect(counts.waiting).toBe(2);
    expect(await emailVerification.getJob(emailVerificationJobId(accountId, 'v1'))).toBeDefined();
    expect(await emailVerification.getJob(emailVerificationJobId(accountId, 'v2'))).toBeDefined();
  });

  it('keys notification.billing_decision jobs on submission_id + decision', async () => {
    const notification = queues[2];
    const submissionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await notification.add(
      'notify',
      {},
      { jobId: billingDecisionNotificationJobId(submissionId, 'approve') },
    );

    expect(
      await notification.getJob(billingDecisionNotificationJobId(submissionId, 'approve')),
    ).toBeDefined();
    expect(
      await notification.getJob(billingDecisionNotificationJobId(submissionId, 'reject')),
    ).toBeUndefined();
  });
});
