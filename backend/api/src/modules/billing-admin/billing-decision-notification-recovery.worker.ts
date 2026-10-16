import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NOTIFICATION_BILLING_DECISION } from '../../common/queues/queue-names';
import { BillingDecisionNotificationOutboxService } from './billing-decision-notification-outbox.service';
import { RESEND_RETRY_CUTOFF_MS } from './resend-idempotency-key';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_BACKOFF_MS = 15_000;

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
 * Independent review repair (2026-10-16), finding 2 — the SAME tick ALSO runs the
 * automatic-quarantine sweep (`sweepAmbiguousPastCutoff`). BullMQ's own `attempts` (5,
 * exponential backoff, ~155s total) can exhaust long before the provider's 24h
 * idempotency-key window does; once exhausted, BullMQ never calls `process()` for that
 * job again, so the processor's own cutoff check would never re-run and the row would
 * stay ambiguous — attempted but never resolved — forever. The sweep needs no BullMQ
 * job, no lease, and no processor invocation: it is a pure, time-based, idempotent
 * `UPDATE` that every running API replica's tick converges on independently. This never
 * claims exactly-once delivery beyond the provider's own window, and never silently
 * drops anything — a swept row is quarantined (durable, visible, requiring explicit
 * reconciliation), never deleted or resent under a fresh key.
 *
 * `tick()` is exposed (not just the interval) so tests and operators can trigger one
 * deterministic pass instead of racing the poll interval.
 */
@Injectable()
export class BillingDecisionNotificationRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingDecisionNotificationRecoveryWorker.name);
  private readonly workerId = `billing-notification-recovery-${randomUUID()}`;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly batchSize: number;
  private readonly backoffMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly outbox: BillingDecisionNotificationOutboxService,
    @InjectQueue(QUEUE_NOTIFICATION_BILLING_DECISION)
    private readonly notificationQueue: Queue,
  ) {
    // Read at CONSTRUCTION (not import) time: operators can size deployments per
    // environment, and tests can spin dedicated replica instances with short leases
    // to exercise genuine lease-takeover between two workers.
    this.pollIntervalMs = Number(
      process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_POLL_MS ?? DEFAULT_POLL_INTERVAL_MS,
    );
    this.leaseDurationMs = Number(
      process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_LEASE_MS ?? DEFAULT_LEASE_DURATION_MS,
    );
    this.batchSize = Number(
      process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_BATCH_SIZE ?? DEFAULT_BATCH_SIZE,
    );
    this.backoffMs = Number(
      process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_BACKOFF_MS ?? DEFAULT_BACKOFF_MS,
    );
  }

  onModuleInit(): void {
    // Escape hatch for unit/contract test module graphs that boot the module without a
    // reachable Redis — never set in a real deployment.
    if (process.env.KEMFAI_DISABLE_BILLING_NOTIFICATION_RECOVERY_WORKER === '1') {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
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
        leaseDurationMs: this.leaseDurationMs,
        batchSize: this.batchSize,
        backoffMs: this.backoffMs,
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
      // Finding 2: independent of (and after) the enqueue-recovery pass above — an
      // ambiguous occurrence has nothing to do with whether its job is still in Redis;
      // it is purely about how long ago the FIRST provider attempt happened.
      const quarantined = await this.outbox.sweepAmbiguousPastCutoff(RESEND_RETRY_CUTOFF_MS);
      if (quarantined > 0) {
        this.logger.warn(
          `quarantined ${quarantined} ambiguous billing decision notification(s) past the ` +
            'conservative provider idempotency-key retry window — needs manual reconciliation',
        );
      }
    } catch (error) {
      this.logger.error(`billing notification recovery tick failed: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
