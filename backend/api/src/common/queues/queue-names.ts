/**
 * Queue names and job-id/dedupe-key strategies for every BullMQ queue in this slice.
 *
 * The names and strategies below are the code-side mirror of the "Background job /
 * notification signals" table in specs/001-saas-onboarding-shell/contracts/events.md
 * (T021 acceptance criterion: "each queue's job-id/dedupe-key strategy matches
 * contracts/events.md's table"). Producers added by later tasks (T032/T033/T044/T062/…)
 * must build their job ids through these helpers instead of inventing per-call strings,
 * so dedupe semantics stay identical across every emission site.
 */

export const QUEUE_TENANT_PROVISION = 'tenant.provision';
export const QUEUE_EMAIL_SEND_VERIFICATION = 'email.send_verification';
export const QUEUE_NOTIFICATION_BILLING_DECISION = 'notification.billing_decision';
export const QUEUE_SUPPORT_ACCESS_EXPIRY_SWEEP = 'support_access.expiry_sweep';
export const QUEUE_TRIAL_EXPIRY_SWEEP = 'trial.expiry_sweep';
export const QUEUE_ACCOUNTING_MUTATION_RECOVERY = 'accounting.mutation_recovery';

export const ALL_QUEUE_NAMES = [
  QUEUE_TENANT_PROVISION,
  QUEUE_EMAIL_SEND_VERIFICATION,
  QUEUE_NOTIFICATION_BILLING_DECISION,
  QUEUE_SUPPORT_ACCESS_EXPIRY_SWEEP,
  QUEUE_TRIAL_EXPIRY_SWEEP,
  QUEUE_ACCOUNTING_MUTATION_RECOVERY,
] as const;

export type QueueName = (typeof ALL_QUEUE_NAMES)[number];

/**
 * Both sweep queues run every 30 seconds (research.md §8; events.md "Scheduled, every
 * 30s"). Their idempotency key is "N/A (sweep, not per-entity)": the single fixed
 * repeatable job registered per sweep queue by QueueSchedulingService IS the dedupe —
 * re-bootstrapping must never create a second schedule (Constitution Principle VII).
 */
export const SWEEP_REPEAT_INTERVAL_MS = 30_000;

/** Fixed job name used by both scheduled sweeps; one repeatable job per sweep queue. */
export const SWEEP_JOB_NAME = 'sweep';

export const ACCOUNTING_RECOVERY_JOB_NAME = 'recover';
export const ACCOUNTING_RECOVERY_REPEAT_INTERVAL_MS = 5_000;

/**
 * Composite job-id separator. BullMQ reserves `:` for its own internal Redis keys and
 * rejects custom job ids containing it ("Custom Id cannot contain :"), so composite keys
 * join their parts with `.` instead — the strategy (which parts form the key) still
 * matches contracts/events.md verbatim.
 */
const JOB_ID_PART_SEPARATOR = '.';

/**
 * tenant.provision — idempotency key is the bare `account_id` used as the unique BullMQ
 * job id (events.md). Duplicate enqueues for the same account collapse to the existing
 * job; the handler (T044) still checks current state before mutating.
 */
export function tenantProvisionJobId(accountId: string): string {
  return accountId;
}

/**
 * email.send_verification — idempotency key is `account_id` + issued token version
 * (events.md): re-issuing a verification link (T034) must produce a NEW job keyed to the
 * new token version while the old job id stays distinct and never silently replays.
 */
export function emailVerificationJobId(accountId: string, tokenVersion: string): string {
  return `${accountId}${JOB_ID_PART_SEPARATOR}${tokenVersion}`;
}

/**
 * notification.billing_decision — idempotency key is `submission_id` + decision +
 * decision occurrence, where the occurrence is the 0-based index of this decision's own
 * entry in the submission's append-only `status_history` (events.md): one notification
 * job per decision occurrence per submission. The occurrence disambiguates repeated
 * more-info cycles on the SAME submission row — a prior waiting/completed job under the
 * first cycle's key must never suppress the latest cycle's notification (FR-035,
 * T070 review finding 2) — while a retried/duplicate attempt for the SAME decision
 * occurrence collapses onto the same id (Constitution Principle VII).
 */
export function billingDecisionNotificationJobId(
  submissionId: string,
  decision: string,
  decisionOccurrence: number,
): string {
  return `${submissionId}${JOB_ID_PART_SEPARATOR}${decision}${JOB_ID_PART_SEPARATOR}${decisionOccurrence}`;
}

/**
 * notification.billing_decision jobs are "retried with backoff" (events.md): the
 * attempts/backoff options below are set on every enqueue (request path, recovery
 * worker, and operator recovery command alike) so the job carries its retry contract
 * the moment a consumer/processor for this queue is introduced. Enqueue-time failures
 * themselves are covered by the `billing_decision_notification_outbox` durability
 * layer (see BillingDecisionNotificationOutboxService), not by these options.
 */
export const BILLING_DECISION_NOTIFICATION_ATTEMPTS = 5;

export const BILLING_DECISION_NOTIFICATION_BACKOFF = {
  type: 'exponential',
  delay: 5_000,
} as const;
