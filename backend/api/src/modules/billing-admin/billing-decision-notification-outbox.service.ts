import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Queue } from 'bullmq';
import controlDataSource from '../../database/data-source';
import {
  BILLING_DECISION_NOTIFICATION_ATTEMPTS,
  BILLING_DECISION_NOTIFICATION_BACKOFF,
} from '../../common/queues/queue-names';

export type BillingDecisionNotificationState = 'pending' | 'enqueued';

export interface BillingDecisionNotificationOutboxRow {
  id: string;
  submissionId: string;
  tenantId: string;
  decision: string;
  decisionOccurrence: number;
  notes: string | null;
  occurredAt: Date;
  jobId: string;
  state: BillingDecisionNotificationState;
  retryCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
}

export interface BillingDecisionNotificationOutboxInput {
  submissionId: string;
  tenantId: string;
  decision: string;
  /** 0-based index of this decision's own status_history entry — the occurrence key. */
  decisionOccurrence: number;
  notes: string | null;
  occurredAt: Date;
  /** The BullMQ job id (`billingDecisionNotificationJobId`) — unique per decision occurrence. */
  jobId: string;
}

export interface BillingDecisionNotificationRecoveryPassResult {
  claimed: number;
  enqueued: number;
  failed: number;
}

interface OutboxInsertQueryResult {
  id: string;
  submission_id: string;
  tenant_id: string;
  decision: string;
  decision_occurrence: number;
  notes: string | null;
  occurred_at: string | Date;
  job_id: string;
  state: BillingDecisionNotificationState;
  retry_count: number;
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
}

function mapRow(row: OutboxInsertQueryResult): BillingDecisionNotificationOutboxRow {
  return {
    id: row.id,
    submissionId: row.submission_id,
    tenantId: row.tenant_id,
    decision: row.decision,
    decisionOccurrence: row.decision_occurrence,
    notes: row.notes,
    occurredAt: new Date(row.occurred_at),
    jobId: row.job_id,
    state: row.state,
    retryCount: row.retry_count,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
  };
}

/**
 * T070 durability (Codex review finding 1) — raw-SQL data access for
 * `billing_decision_notification_outbox`, following the `company_mutation_handoff`
 * idiom (T055): short, independent statements, and the pending row is written through
 * the DECISION's own transaction manager so decision + audit + notification intent
 * commit atomically. The Redis enqueue happens strictly after that commit; until an
 * enqueue provably succeeded the row stays `pending`, and this service is the ONLY
 * thing the recovery worker and the operator recovery command read to converge it.
 */
@Injectable()
export class BillingDecisionNotificationOutboxService {
  /**
   * Commits the notification intent INSIDE the caller's (decision) transaction. Must be
   * called with that transaction's manager — never the bare DataSource — or the row
   * could outlive a rolled-back decision. The unique `job_id` constraint makes a
   * duplicate write for the same decision occurrence impossible (the duplicate-decision
   * path is already blocked earlier by the row lock + 409; this is defense in depth).
   */
  async recordPending(
    manager: EntityManager,
    input: BillingDecisionNotificationOutboxInput,
  ): Promise<BillingDecisionNotificationOutboxRow> {
    const inserted = (await manager.query(
      `INSERT INTO "billing_decision_notification_outbox"
         ("submission_id","tenant_id","decision","decision_occurrence","notes","occurred_at","job_id")
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT ("job_id") DO UPDATE SET "updated_at" = now()
       RETURNING *`,
      [
        input.submissionId,
        input.tenantId,
        input.decision,
        input.decisionOccurrence,
        input.notes,
        input.occurredAt.toISOString(),
        input.jobId,
      ],
    )) as OutboxInsertQueryResult[];
    return mapRow(inserted[0]);
  }

  /** Terminal transition: the job is durably in Redis; the row is never reclaimed. */
  async markEnqueued(id: string): Promise<void> {
    await controlDataSource.query(
      `UPDATE "billing_decision_notification_outbox"
        SET "state" = 'enqueued', "lease_owner" = NULL, "lease_expires_at" = NULL,
            "next_attempt_at" = NULL, "updated_at" = now()
        WHERE "id" = $1`,
      [id],
    );
  }

  /**
   * Lease-based claim for the recovery worker / operator command (same shape as
   * `CompanyMutationHandoffService.claimBatchForRecovery`): `FOR UPDATE SKIP LOCKED`
   * lets concurrent workers and API replicas claim disjoint batches safely; only rows
   * still pending, unleased or lease-expired, and past their backoff window are
   * eligible — an `enqueued` row is terminal and never reclaimed.
   */
  async claimBatchForRecovery(
    leaseOwner: string,
    leaseDurationMs: number,
    batchSize: number,
  ): Promise<BillingDecisionNotificationOutboxRow[]> {
    const result = await controlDataSource.query(
      `WITH "claimable" AS (
         SELECT "id" FROM "billing_decision_notification_outbox"
         WHERE "state" = 'pending'
           AND ("lease_expires_at" IS NULL OR "lease_expires_at" < now())
           AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= now())
         ORDER BY "created_at" ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       UPDATE "billing_decision_notification_outbox" o
       SET "lease_owner" = $1,
           "lease_expires_at" = now() + ($2 * interval '1 millisecond'),
           "retry_count" = o."retry_count" + 1,
           "updated_at" = now()
       FROM "claimable" c
       WHERE o."id" = c."id"
       RETURNING o.*`,
      [leaseOwner, leaseDurationMs, batchSize],
    );
    // TypeORM's raw-query driver returns a bare rows array for INSERT/SELECT ...
    // RETURNING, but a [rows, affectedRowCount] tuple for UPDATE/DELETE ... RETURNING
    // (same verified behavior CompanyMutationHandoffService unwraps).
    const rows = Array.isArray(result[0]) ? result[0] : result;
    return (rows as OutboxInsertQueryResult[]).map(mapRow);
  }

  /**
   * Bounded backoff on a failed enqueue attempt (e.g. Redis still down): releases the
   * lease and schedules a later retry rather than hot-looping a broken dependency.
   */
  async scheduleRetryBackoff(id: string, delayMs: number): Promise<void> {
    await controlDataSource.query(
      `UPDATE "billing_decision_notification_outbox"
        SET "lease_owner" = NULL, "lease_expires_at" = NULL,
            "next_attempt_at" = now() + ($2 * interval '1 millisecond'),
            "updated_at" = now()
        WHERE "id" = $1`,
      [id, delayMs],
    );
  }

  /**
   * Enqueues one row's job exactly as the request path does — same job name, data, and
   * occurrence-keyed job id, same events.md attempts/backoff options — and marks the
   * row enqueued. BullMQ dedupes on the job id, so re-running this for an already
   * enqueued occurrence is a no-op at the queue. Throws on Redis failure; the caller
   * decides whether to back off (worker) or surface the failure (operator command).
   */
  async dispatch(row: BillingDecisionNotificationOutboxRow, queue: Queue): Promise<void> {
    await queue.add(
      'notify',
      {
        submissionId: row.submissionId,
        tenantId: row.tenantId,
        decision: row.decision,
        decisionOccurrence: row.decisionOccurrence,
        notes: row.notes,
        occurredAt: row.occurredAt.toISOString(),
      },
      {
        jobId: row.jobId,
        attempts: BILLING_DECISION_NOTIFICATION_ATTEMPTS,
        backoff: BILLING_DECISION_NOTIFICATION_BACKOFF,
      },
    );
    await this.markEnqueued(row.id);
  }

  /**
   * One claim-and-dispatch pass, shared verbatim by the in-process recovery worker and
   * the operator recovery command, so both converge pending rows through the exact same
   * lease/backoff semantics. Failed enqueues are backed off here and remain pending —
   * they never abort the pass.
   */
  async runRecoveryPass(options: {
    queue: Queue;
    leaseOwner: string;
    leaseDurationMs: number;
    batchSize: number;
    backoffMs: number;
    onError?: (row: BillingDecisionNotificationOutboxRow, error: Error) => void;
  }): Promise<BillingDecisionNotificationRecoveryPassResult> {
    const batch = await this.claimBatchForRecovery(
      options.leaseOwner,
      options.leaseDurationMs,
      options.batchSize,
    );
    let enqueued = 0;
    let failed = 0;
    for (const row of batch) {
      try {
        await this.dispatch(row, options.queue);
        enqueued += 1;
      } catch (error) {
        failed += 1;
        options.onError?.(row, error as Error);
        await this.scheduleRetryBackoff(row.id, options.backoffMs);
      }
    }
    return { claimed: batch.length, enqueued, failed };
  }

  /** Ops/monitoring surface: how many notification intents are still not in Redis. */
  async countPending(): Promise<number> {
    const rows = (await controlDataSource.query(
      'SELECT COUNT(*)::int AS count FROM "billing_decision_notification_outbox" WHERE "state" = \'pending\'',
    )) as Array<{ count: number }>;
    return rows[0].count;
  }
}
