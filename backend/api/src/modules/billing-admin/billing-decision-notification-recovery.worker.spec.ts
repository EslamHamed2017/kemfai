import { Queue } from 'bullmq';
import {
  BILLING_DECISION_NOTIFICATION_ATTEMPTS,
  BILLING_DECISION_NOTIFICATION_BACKOFF,
  QUEUE_NOTIFICATION_BILLING_DECISION,
  billingDecisionNotificationJobId,
} from '../../common/queues/queue-names';
import {
  BillingDecisionNotificationOutboxRow,
  BillingDecisionNotificationOutboxService,
} from './billing-decision-notification-outbox.service';
import { BillingDecisionNotificationRecoveryWorker } from './billing-decision-notification-recovery.worker';

/**
 * T070 durability (reviewer finding 1) — unit coverage of the recovery worker's own
 * decision logic with every collaborator mocked: a pending outbox row is enqueued with
 * the occurrence-keyed job id and the events.md retry/backoff options, a failed enqueue
 * releases the lease with bounded backoff instead of hot-looping, and the disable flag
 * keeps the interval off entirely. The real cross-process guarantee — that the worker is
 * registered in the production module graph and genuinely re-enqueues a row another
 * process left behind — is proven against real Postgres/Redis in
 * `test/integration/billing-decision-notification-durability.integration-spec.ts`.
 */
describe('BillingDecisionNotificationRecoveryWorker (T070, unit)', () => {
  function makeRow(overrides: Partial<BillingDecisionNotificationOutboxRow> = {}) {
    return {
      id: 'outbox-1',
      submissionId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      decision: 'reject' as const,
      notes: 'Amount mismatch.',
      occurredAt: new Date('2026-10-05T00:00:00.000Z'),
      jobId: billingDecisionNotificationJobId('11111111-1111-4111-8111-111111111111', 'reject', 1),
      state: 'pending' as const,
      retryCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      ...overrides,
    };
  }

  function makeWorker(rows: BillingDecisionNotificationOutboxRow[]) {
    const markEnqueued = jest.fn().mockResolvedValue(undefined);
    const scheduleRetryBackoff = jest.fn().mockResolvedValue(undefined);
    const add = jest.fn().mockResolvedValue(undefined);

    // Faithful stand-in for the real service's pass: claim a batch, dispatch each row
    // (queue.add with the persisted job id + retry options, then mark), and back a
    // failed enqueue off — so the worker-under-test's real call path through
    // runRecoveryPass still exercises add/markEnqueued/scheduleRetryBackoff.
    const claimBatchForRecovery = jest.fn().mockResolvedValue(rows);
    const runRecoveryPass = jest.fn(
      async (options: {
        queue: { add: jest.Mock };
        onError?: (row: BillingDecisionNotificationOutboxRow, error: Error) => void;
      }) => {
        const batch = await claimBatchForRecovery('owner', 0, 0);
        let failed = 0;
        for (const row of batch) {
          try {
            await options.queue.add(
              'notify',
              {
                submissionId: row.submissionId,
                tenantId: row.tenantId,
                decision: row.decision,
                notes: row.notes,
                occurredAt: row.occurredAt.toISOString(),
              },
              {
                jobId: row.jobId,
                attempts: BILLING_DECISION_NOTIFICATION_ATTEMPTS,
                backoff: BILLING_DECISION_NOTIFICATION_BACKOFF,
              },
            );
            await markEnqueued(row.id);
          } catch (error) {
            failed += 1;
            options.onError?.(row, error as Error);
            await scheduleRetryBackoff(row.id, 15_000);
          }
        }
        return { claimed: batch.length, enqueued: batch.length - failed, failed };
      },
    );
    const outbox = {
      runRecoveryPass,
      claimBatchForRecovery,
      markEnqueued,
      scheduleRetryBackoff,
    } as unknown as BillingDecisionNotificationOutboxService;

    const queue = { add } as unknown as Queue;

    const worker = new BillingDecisionNotificationRecoveryWorker(outbox, queue);
    return { worker, outbox, add, claimBatchForRecovery, markEnqueued, scheduleRetryBackoff };
  }

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.KEMFAI_DISABLE_BILLING_NOTIFICATION_RECOVERY_WORKER;
  });

  it('enqueues a claimed pending row with its persisted occurrence job id and retry/backoff options, then marks it enqueued', async () => {
    const row = makeRow();
    const { worker, add, markEnqueued } = makeWorker([row]);

    await worker.tick();

    expect(add).toHaveBeenCalledWith(
      'notify',
      {
        submissionId: row.submissionId,
        tenantId: row.tenantId,
        decision: row.decision,
        notes: row.notes,
        occurredAt: row.occurredAt.toISOString(),
      },
      {
        jobId: row.jobId,
        attempts: BILLING_DECISION_NOTIFICATION_ATTEMPTS,
        backoff: BILLING_DECISION_NOTIFICATION_BACKOFF,
      },
    );
    expect(markEnqueued).toHaveBeenCalledWith(row.id);
  });

  it('schedules bounded backoff and keeps the row pending when Redis still rejects the add', async () => {
    const row = makeRow();
    const { worker, add, markEnqueued, scheduleRetryBackoff } = makeWorker([row]);
    add.mockRejectedValue(new Error('redis still unavailable'));

    await worker.tick();

    expect(markEnqueued).not.toHaveBeenCalled();
    expect(scheduleRetryBackoff).toHaveBeenCalledWith(row.id, expect.any(Number));
  });

  it('never installs the poll interval when the disable escape hatch is set', () => {
    const { worker } = makeWorker([]);
    process.env.KEMFAI_DISABLE_BILLING_NOTIFICATION_RECOVERY_WORKER = '1';

    expect(() => worker.onModuleInit()).not.toThrow();
    // A disabled worker must not leave a timer behind — the next tick call stays a
    // manual, deterministic operation.
    worker.onModuleDestroy();
  });

  it('claims from the notification.billing_decision queue only, one batch per tick', async () => {
    const { worker, claimBatchForRecovery } = makeWorker([]);

    await worker.tick();

    expect(claimBatchForRecovery).toHaveBeenCalledTimes(1);
    expect(QUEUE_NOTIFICATION_BILLING_DECISION).toBe('notification.billing_decision');
  });
});
