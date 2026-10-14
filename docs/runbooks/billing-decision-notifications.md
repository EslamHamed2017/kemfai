# Runbook: Billing decision customer notifications (FR-035, T070)

Scope: the durable enqueue AND the customer delivery of `notification.billing_decision`
notifications for every Billing Admin decision (approve / reject / request-more-info) on
`POST /internal/billing/payment-submissions/{id}/{approve|reject|request-more-info}`.

## What this system guarantees

**Durable enqueue:** every decision that commits durably (status flip + append-only
history + FR-009 audit + outbox row, all in ONE PostgreSQL transaction) eventually gets
a `notification.billing_decision` job enqueued into Redis/BullMQ — exactly one job per
decision occurrence — even when Redis is down at decision time or the API process
crashes between commit and enqueue.

**Actual customer delivery (Acceptance Scenarios 6.3/6.4):**
`BillingDecisionNotificationProcessor` (registered in `BillingAdminModule`, the standard
BullMQ worker lifecycle — no extra scheduler) consumes the queue, re-reads the sealed
decision from the control plane, verifies the decision occurrence still matches the
append-only `status_history` (stale jobs are rejected), and sends the workspace owner a
localized (en/ar, per `account.preferred_locale`) email with the outcome and the
rejection reason / requested specifics through the configured SMTP transport
(`SmtpBillingDecisionNotificationTransport`: a dependency-free RFC 5321/5322 client over
node `net`/`tls`). Delivery failures (relay down, misconfiguration) fail the job and are
retried by BullMQ with backoff (`attempts: 5`, exponential 5s — see
`BILLING_DECISION_NOTIFICATION_*` in `backend/api/src/common/queues/queue-names.ts`);
delivery is at-least-once per decision occurrence, exactly-once at the queue.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `SMTP_URL` | yes for delivery | Relay endpoint, `smtp://host:port` (or `smtps://` for implicit TLS); credentials via `smtp://user:pass@host:port` |
| `SMTP_FROM` | yes for delivery | Envelope/From header, e.g. `KEMFAI Billing <billing@kemfai.example>` |

Missing SMTP configuration or an unreachable relay fails the delivery jobs (visible as
`failed` jobs with the transport's error) — a notification is never silently dropped.

## How durability works

1. **Commit** — the decision transaction writes
   `billing_decision_notification_outbox` (state `pending`) together with the decision,
   history, and audit. Commit is all-or-nothing: a failed audit append rolls the outbox
   row back too, so an uncommitted decision can never notify.
2. **Dispatch** — after the transaction resolves, the API immediately enqueues the job
   (job id = `submission_id` + decision + decision occurrence — the decision's own
   `status_history` entry index, so repeated more-info cycles never collide) and marks
   the row `enqueued`. A Redis failure here is logged
   (`BillingAdminService` / "notification.billing_decision enqueue failed") and the row
   simply stays `pending` — the HTTP decision response still succeeds.
3. **Reconcile** — `BillingDecisionNotificationRecoveryWorker` (registered in
   `BillingAdminModule`, i.e. in every running API replica) polls pending rows every 5s
   (env-tunable), claims them with a lease (`FOR UPDATE SKIP LOCKED` — safe with
   multiple replicas), re-enqueues, and marks `enqueued`. Failures back off bounded
   (`next_attempt_at` + 15s default), never hot-looping a down Redis. BullMQ's job-id
   dedupe makes re-dispatch exactly-once per decision occurrence.

## Monitoring

Pending (not-yet-enqueued) notification intents:

```sql
SELECT job_id, submission_id, decision, retry_count, next_attempt_at, lease_owner, updated_at
  FROM billing_decision_notification_outbox
 WHERE state = 'pending'
 ORDER BY updated_at;
```

A healthy steady state is zero rows. Rows with growing `retry_count` and advancing
`next_attempt_at` mean Redis (or the DB) is refusing enqueues — see below.

Delivery-side health is the BullMQ queue itself (`notification.billing_decision`): a
healthy steady state is zero `waiting`/`failed` jobs; `failedReason` on failed jobs
carries the SMTP transport error (relay refused, timeout, misconfiguration). Successful
deliveries are also logged by the processor
(`billing decision notification delivered: submission … to …`).

## Operator recovery command

The in-process worker needs no operator action in normal operation. To force an
immediate sweep (e.g. after a Redis outage, or when a replica was stopped with rows
still pending):

```bash
cd backend/api && npm run notify:recover
```

- Drains all pending rows in batches through the exact same lease/backoff dispatch path
  as the worker; prints `enqueued=… failed=… stillPending=…`.
- Exit code `0` = nothing pending remains; `1` = rows are still pending (see errors).
- Safe to re-run any number of times, from any host with DB + Redis reachability: the
  unique `job_id` keeps every occurrence exactly-once at the queue.

## Redis outage procedure

1. Decisions keep succeeding (FR-035 notification failures never block or fail the
   decision); rows accumulate in `pending` with logged enqueue failures.
2. Restore Redis.
3. Run `npm run notify:recover` (or wait ≤ poll interval + backoff for the worker).
4. Verify the pending query above returns zero rows.

## Incident notes

- A `pending` row with `retry_count` stopped mid-outage but `lease_expires_at` in the
  future: a replica died holding the lease; the row self-heals once the lease expires
  (default 30s) — no action needed.
- `enqueued` is terminal by design; the row is retained as the durable audit of the
  handoff and never reclaimed.
- Deleting a `payment_submission` row (data retention / test fixtures) cascades its
  outbox rows away — no orphaned notification intents can linger.

## Environment knobs

| Variable | Default | Purpose |
|---|---|---|
| `KEMFAI_BILLING_NOTIFICATION_RECOVERY_POLL_MS` | `5000` | Worker poll interval |
| `KEMFAI_BILLING_NOTIFICATION_RECOVERY_LEASE_MS` | `30000` | Claim lease duration |
| `KEMFAI_BILLING_NOTIFICATION_RECOVERY_BATCH_SIZE` | `10` (worker) / `25` (command) | Rows claimed per pass |
| `KEMFAI_BILLING_NOTIFICATION_RECOVERY_BACKOFF_MS` | `15000` | Bounded failure backoff |
| `KEMFAI_DISABLE_BILLING_NOTIFICATION_RECOVERY_WORKER` | unset | Set `1` to disable the in-process worker (test-only escape hatch) |
