import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import 'reflect-metadata';
import controlDataSource from '../database/data-source';
import { QUEUE_NOTIFICATION_BILLING_DECISION } from '../common/queues/queue-names';
import { redisConnectionFromUrl } from '../common/queues/redis-connection';
import { BillingDecisionNotificationOutboxService } from '../modules/billing-admin/billing-decision-notification-outbox.service';

/**
 * T070 operator recovery command (Codex review finding 1) — the explicit, human-driven
 * counterpart to the in-process recovery worker: sweep every still-`pending`
 * `billing_decision_notification_outbox` row into the `notification.billing_decision`
 * BullMQ queue now, without waiting for the poll interval or an API replica.
 *
 * Usage (see docs/runbooks/billing-decision-notifications.md):
 *   cd backend/api && npm run notify:recover
 *
 * Exit codes: 0 — no pending rows remain (including "there was nothing to do");
 * 1 — rows are still pending (Redis or the control DB refused; see the printed errors
 * and the runbook's Redis-outage procedure). Safe to re-run as often as needed: job-id
 * dedupe keeps every occurrence exactly-once at the queue.
 */

const BATCH_SIZE = Number(process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_BATCH_SIZE ?? 25);
const LEASE_DURATION_MS = Number(
  process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_LEASE_MS ?? 30_000,
);
const BACKOFF_MS = Number(process.env.KEMFAI_BILLING_NOTIFICATION_RECOVERY_BACKOFF_MS ?? 15_000);
const MAX_PASSES = 200;

async function main(): Promise<number> {
  if (!controlDataSource.isInitialized) {
    await controlDataSource.initialize();
  }
  const outbox = new BillingDecisionNotificationOutboxService();
  const queue = new Queue(QUEUE_NOTIFICATION_BILLING_DECISION, {
    connection: redisConnectionFromUrl(),
  });
  const leaseOwner = `operator-recover-${randomUUID()}`;
  let totalEnqueued = 0;
  let totalFailed = 0;

  try {
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const result = await outbox.runRecoveryPass({
        queue,
        leaseOwner,
        leaseDurationMs: LEASE_DURATION_MS,
        batchSize: BATCH_SIZE,
        backoffMs: BACKOFF_MS,
        onError: (row, error) => {
          process.stdout.write(
            `FAILED  ${row.jobId} (submission ${row.submissionId}, ${row.decision}): ` +
              `${error.message}\n`,
          );
        },
      });
      totalEnqueued += result.enqueued;
      totalFailed += result.failed;
      if (result.claimed === 0) {
        break;
      }
    }
    const pending = await outbox.countPending();
    process.stdout.write(
      `billing decision notification recovery: enqueued=${totalEnqueued} ` +
        `failed=${totalFailed} stillPending=${pending}\n`,
    );
    return pending === 0 ? 0 : 1;
  } finally {
    await queue.close().catch(() => undefined);
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: Error) => {
    process.stderr.write(`billing decision notification recovery aborted: ${error.message}\n`);
    process.exitCode = 1;
  });
