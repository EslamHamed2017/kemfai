import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NOTIFICATION_BILLING_DECISION } from '../../common/queues/queue-names';
import { BillingDecisionNotificationOutboxService } from './billing-decision-notification-outbox.service';

const POLL_INTERVAL_MS = Number(process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_POLL_MS ?? 5_000);
const LEASE_DURATION_MS = Number(
  process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_LEASE_MS ?? 30_000,
);
const BATCH_SIZE = Number(process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_BATCH_SIZE ?? 10);
const BACKOFF_MS = Number(process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_BACKOFF_MS ?? 15_000);

/**
 * T070 durability (Codex review finding 1) — the FR-035 notification reconciler,
 * registered as an ordinary provider in `BillingAdminModule` (so it lives in the real
 * production module graph — `AppModule` imports `BillingAdminModule`), following the
 * established `CompanyMutationRecoveryWorker` pattern (T055) rather than introducing a
 * new scheduler. It continuously claims still-`pending` outbox rows — a decision whose
 * Redis enqueue failed or whose process crashed between commit and enqueue — and
 * re-enqueues them WITHOUT any further HTTP request:
 *
 * - the job id, payload, and attempts/backoff options all come from the immutable
 *   outbox row via the shared `runRecoveryPass`, identical to the request path;
 * - BullMQ's job-id dedupe keeps the enqueue exactly-once per decision occurrence, so
 *   a crash between `queue.add` and `markEnqueued` heals to the same single job;
 * - lease-based `FOR UPDATE SKIP LOCKED` claiming is safe with multiple API replicas;
 * - failures back off bounded (`next_attempt_at`), never hot-looping a down Redis.
 *
 * `tick()` is exposed (not just the interval) so tests and operators can trigger one
 * deterministic pass instead of racing the poll interval.
 */
@Injectable()
export class BillingDecisionNotificationRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingDecisionNotificationRecoveryWorker.name);
  private readonly workerId = `billing-notification-recovery-${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly outbox: BillingDecisionNotificationOutboxService,
    @InjectQueue(QUEUE_NOTIFICATION_BILLING_DECISION)
    private readonly notificationQueue: Queue,
  ) {}

  onModuleInit(): void {
    // Escape hatch for unit/contract test module graphs that boot the module without a
    // reachable Redis — never set in a real deployment.
    if (process.env.KEMFAI_DISABLE_BILLING_NOTIFICATION_RECOVERY_WORKER === '1') {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) {
      return;
    }
    this.ticking = true;
    try {
      const result = await this.outbox.runRecoveryPass({
        queue: this.notificationQueue,
        leaseOwner: this.workerId,
        leaseDurationMs: LEASE_DURATION_MS,
        batchSize: BATCH_SIZE,
        backoffMs: BACKOFF_MS,
        onError: (row, error) => {
          this.logger.warn(
            `billing decision notification recovery attempt failed for submission ` +
              `${row.submissionId} (${row.decision}, job ${row.jobId}): ${error.message}`,
          );
        },
      });
      if (result.enqueued > 0) {
        this.logger.log(`recovered ${result.enqueued} pending billing decision notification(s)`);
      }
    } catch (error) {
      this.logger.error(`billing notification recovery tick failed: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
