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
  deliveredAt: Date | null;
  /** First time the Resend transport was ever invoked for this occurrence; immutable once set. */
  firstSendAttemptedAt: Date | null;
  /**
   * The COMPLETE, already-serialized JSON request body persisted at the first send
   * attempt (including the sender — `ResendBillingDecisionNotificationTransport.
   * buildRequestBody`); immutable once set. Every attempt — including the first —
   * POSTs these exact bytes verbatim via `sendRaw`, never rebuilding them, so the
   * payload is provably byte-identical across crashes/restarts/lease loss/config
   * drift (e.g. `RESEND_FROM` changing)/races.
   */
  providerRequestBody: string | null;
  /** The Resend-assigned email id, persisted only once the provider confirmed acceptance. */
  providerMessageId: string | null;
  /** Set on a 409 (same key, mismatched payload) — fail-closed, never auto-resent. */
  deliveryRejectedAt: Date | null;
  /** Set when an unresolved occurrence crosses the conservative retry cutoff — never resent under a new key. */
  quarantinedAt: Date | null;
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
  delivered_at: string | Date | null;
  first_send_attempted_at: string | Date | null;
  provider_request_body: string | null;
  provider_message_id: string | null;
  delivery_rejected_at: string | Date | null;
  quarantined_at: string | Date | null;
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
    deliveredAt: row.delivered_at ? new Date(row.delivered_at) : null,
    firstSendAttemptedAt: row.first_send_attempted_at
      ? new Date(row.first_send_attempted_at)
      : null,
    providerRequestBody: row.provider_request_body,
    providerMessageId: row.provider_message_id,
    deliveryRejectedAt: row.delivery_rejected_at ? new Date(row.delivery_rejected_at) : null,
    quarantinedAt: row.quarantined_at ? new Date(row.quarantined_at) : null,
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

  /**
   * T070 same-occurrence delivery idempotency: loads the full row the delivery-boundary
   * state lives on (`delivered_at`/`quarantined_at`/`delivery_rejected_at`/
   * `first_send_attempted_at`), keyed by the BullMQ job id the processor already has.
   * `null` means the occurrence has no outbox row at all — a stale/foreign job.
   */
  async findByJobId(jobId: string): Promise<BillingDecisionNotificationOutboxRow | null> {
    const rows = (await controlDataSource.query(
      'SELECT * FROM "billing_decision_notification_outbox" WHERE "job_id" = $1',
      [jobId],
    )) as OutboxInsertQueryResult[];
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Owner decision 2026-10-15T16:33:05Z, clarified in targeted repairs 2 and the
   * 2026-10-16 independent review repair — the atomic pre-send claim. Durably stamps
   * `first_send_attempted_at` (the reference point for the provider's 24h idempotency
   * window) and the COMPLETE serialized provider request body ONCE, before the HTTP
   * call ever happens, and reports the row's CURRENT terminal-state markers so the
   * caller never calls the provider for an occurrence already delivered, quarantined,
   * or rejected. A single guarded `UPDATE` is the whole claim: Postgres serializes
   * concurrent callers on the row lock, and the second caller's `WHERE` is
   * re-evaluated against the first caller's committed result, so two overlapping
   * processors always converge on the SAME `first_send_attempted_at` AND the SAME
   * persisted request body (never each building — and sending — their own), without
   * any separate lease. `candidateRequestBody` is only ever used the first time; every
   * later call's own build is discarded in favor of what is already durably
   * persisted — this is what makes the payload provably byte-identical on retry rather
   * than merely "probably the same because the inputs probably didn't change" (they
   * can: e.g. `account.preferred_locale` or `RESEND_FROM` changing between a crashed
   * attempt and its retry).
   */
  async beginSendAttempt(
    id: string,
    candidateRequestBody: string,
  ): Promise<BillingDecisionNotificationOutboxRow> {
    const result = await controlDataSource.query(
      `UPDATE "billing_decision_notification_outbox"
        SET "first_send_attempted_at" = COALESCE("first_send_attempted_at", now()),
            "provider_request_body" = COALESCE("provider_request_body", $2),
            "updated_at" = now()
        WHERE "id" = $1
          AND "delivered_at" IS NULL AND "quarantined_at" IS NULL AND "delivery_rejected_at" IS NULL
        RETURNING *`,
      [id, candidateRequestBody],
    );
    // Same pg-driver quirk `claimBatchForRecovery` already unwraps: UPDATE ... RETURNING
    // comes back as a [rows, affectedRowCount] tuple, not a bare rows array (unlike
    // INSERT ... RETURNING, which `recordPending`/`findByJobId` rely on being bare). Using
    // `updated[0]` directly here (an array, not a row) was exactly why
    // `first_send_attempted_at` kept hydrating as null/undefined downstream.
    const updated = (Array.isArray(result[0]) ? result[0] : result) as OutboxInsertQueryResult[];
    if (updated[0]) return mapRow(updated[0]);
    // Already terminal (delivered/quarantined/rejected elsewhere, including by a
    // concurrent caller that committed first) — re-read the authoritative row.
    const current = (await controlDataSource.query(
      'SELECT * FROM "billing_decision_notification_outbox" WHERE "id" = $1',
      [id],
    )) as OutboxInsertQueryResult[];
    return mapRow(current[0]);
  }

  /**
   * Provider acceptance is authoritative and highest precedence. If a cutoff sweep or
   * 409 handler raced an already-in-flight request, this atomic update reconciles the
   * row to delivered and clears the lower-precedence marker; a later lower-precedence
   * transition cannot overwrite it because every such transition requires
   * `delivered_at IS NULL`.
   */
  async markDelivered(id: string, providerMessageId: string): Promise<void> {
    await controlDataSource.query(
      `UPDATE "billing_decision_notification_outbox"
        SET "delivered_at" = now(), "provider_message_id" = $2,
            "delivery_rejected_at" = NULL, "quarantined_at" = NULL,
            "updated_at" = now()
        WHERE "id" = $1 AND "delivered_at" IS NULL`,
      [id, providerMessageId],
    );
  }

  /**
   * Fail-closed: the provider answered 409 for the occurrence's own stable key — the
   * replayed payload no longer matches what the provider has on record for that key.
   * Terminal; needs explicit manual reconciliation, never an automatic resend under a
   * fresh key (that would defeat the whole point of a stable per-occurrence key).
   */
  async markDeliveryRejected(id: string): Promise<void> {
    await controlDataSource.query(
      `UPDATE "billing_decision_notification_outbox"
        SET "delivery_rejected_at" = now(), "quarantined_at" = NULL, "updated_at" = now()
        WHERE "id" = $1 AND "delivered_at" IS NULL AND "delivery_rejected_at" IS NULL`,
      [id],
    );
  }

  /**
   * Conservative retry-window boundary: an occurrence whose first attempt is old enough
   * that a further retry could land outside (or too close to) the provider's documented
   * 24h idempotency-key retention is quarantined instead of retried — resending past
   * that window risks the provider treating the SAME key as new and creating a genuine
   * duplicate, which this design exists specifically to prevent. Terminal; requires
   * explicit reconciliation (checking the provider by `provider_message_id`/the stored
   * key), never a fresh key.
   */
  async markQuarantined(id: string): Promise<void> {
    await controlDataSource.query(
      `UPDATE "billing_decision_notification_outbox"
        SET "quarantined_at" = now(), "updated_at" = now()
        WHERE "id" = $1 AND "delivered_at" IS NULL
          AND "delivery_rejected_at" IS NULL AND "quarantined_at" IS NULL`,
      [id],
    );
  }

  /** Ops/monitoring surface: how many notification intents are still not in Redis. */
  async countPending(): Promise<number> {
    const rows = (await controlDataSource.query(
      'SELECT COUNT(*)::int AS count FROM "billing_decision_notification_outbox" WHERE "state" = \'pending\'',
    )) as Array<{ count: number }>;
    return rows[0].count;
  }

  /**
   * Independent review repair (2026-10-16), finding 2 — automatic quarantine. BullMQ's
   * own `attempts` (5, exponential backoff ~155s total) can exhaust long before the
   * provider's 24h idempotency-key window does; once exhausted, BullMQ never calls
   * `process()` for that job again, so the 23h cutoff check INSIDE the processor would
   * never re-run and an ambiguous (attempted but unresolved) occurrence would stay in
   * limbo forever — never quarantined, never reconciled, silently. This sweep is the
   * fix: a pure, time-based, idempotent `UPDATE` that needs no processor invocation,
   * no lease, and no BullMQ job at all. Safe to call from any number of concurrent
   * worker replicas — each caller's `WHERE` excludes rows a concurrent caller (or the
   * processor itself) already resolved, so no row is ever double-quarantined or
   * quarantined out from under a delivery that just succeeded. Returns the count of
   * rows this call itself quarantined (for logging/metrics only).
   */
  async sweepAmbiguousPastCutoff(cutoffMs: number): Promise<number> {
    const result = await controlDataSource.query(
      `UPDATE "billing_decision_notification_outbox"
        SET "quarantined_at" = now(), "updated_at" = now()
        WHERE "first_send_attempted_at" IS NOT NULL
          AND "first_send_attempted_at" < now() - ($1 * interval '1 millisecond')
          AND "delivered_at" IS NULL
          AND "quarantined_at" IS NULL
          AND "delivery_rejected_at" IS NULL
        RETURNING "id"`,
      [cutoffMs],
    );
    // Same pg UPDATE...RETURNING tuple-shape caveat as `beginSendAttempt` — unwrap
    // before counting, or every sweep would silently "find" one phantom row too many.
    const quarantined = Array.isArray(result[0]) ? result[0] : result;
    return (quarantined as unknown[]).length;
  }
}
