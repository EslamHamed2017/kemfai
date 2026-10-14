# Runbook: Billing decision customer notifications (FR-035, T070)

Scope: the durable enqueue of `notification.billing_decision` jobs for every Billing
Admin decision (approve / reject / request-more-info) on
`POST /internal/billing/payment-submissions/{id}/{approve|reject|request-more-info}`.

## What this system guarantees (and what it does NOT)

**Guaranteed (this slice, T070):** every decision that commits durably (status flip +
append-only history + FR-009 audit + outbox row, all in ONE PostgreSQL transaction)
eventually gets a `notification.billing_decision` job enqueued into Redis/BullMQ —
exactly one job per decision occurrence — even when Redis is down at decision time or
the API process crashes between commit and enqueue.

**NOT in this slice (delivery boundary):** there is no consumer/processor for
`notification.billing_decision` in this repository yet, and no email/SMS transport is
wired. T070's contract ends at the durable queue handoff (contracts/events.md). When a
notification delivery task lands, the jobs already carry their retry contract
(`attempts: 5`, exponential `backoff: 5s` delay — see `BILLING_DECISION_NOTIFICATION_*`
in `backend/api/src/common/queues/queue-names.ts`).

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
