import { QUEUE_NOTIFICATION_BILLING_DECISION } from '../../common/queues/queue-names';

/**
 * Owner decision 2026-10-15T16:33:05Z — the Resend `Idempotency-Key` for a billing
 * decision notification is deterministic and depends ONLY on the occurrence's own
 * immutable outbox row id (never recomputed from mutable state), so every retry across
 * crashes, restarts, lost acknowledgments, and concurrent processors reuses the exact
 * same key and therefore the exact same provider-side result
 * (https://resend.com/docs/dashboard/emails/idempotency-keys). There is no code path
 * that mints a fresh key for an already-attempted occurrence — a quarantined or
 * rejected occurrence is never retried under a new key (see
 * `BillingDecisionNotificationOutboxService`).
 */
export function resendIdempotencyKey(occurrenceId: string): string {
  return `kemfai/${QUEUE_NOTIFICATION_BILLING_DECISION}/${occurrenceId}`;
}

/**
 * Resend retains an Idempotency-Key for 24h
 * (https://resend.com/docs/dashboard/emails/idempotency-keys). An ambiguous occurrence
 * (first attempt happened, acceptance was never confirmed) must stop retrying — and be
 * quarantined for explicit manual reconciliation instead — comfortably BEFORE that
 * window closes: retrying right at (or past) the boundary risks the provider treating
 * the SAME key as expired/unknown and accepting it as a brand-new send, which would be
 * the exact duplicate this whole design exists to prevent. One conservative hour of
 * safety margin is deliberately generous given notification jobs are not latency
 * sensitive.
 */
export const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RESEND_IDEMPOTENCY_SAFETY_MARGIN_MS = 60 * 60 * 1000;
export const RESEND_RETRY_CUTOFF_MS =
  RESEND_IDEMPOTENCY_WINDOW_MS - RESEND_IDEMPOTENCY_SAFETY_MARGIN_MS;
