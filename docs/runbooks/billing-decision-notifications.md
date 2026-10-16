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
rejection reason / requested specifics through the configured Resend transport
(`ResendBillingDecisionNotificationTransport`: Node's own `fetch`, zero new
dependencies, calling
[`POST /emails`](https://resend.com/docs/api-reference/emails/send-email)). Delivery
failures (provider down, misconfiguration) fail the job and are retried by BullMQ with
backoff (`attempts: 5`, exponential 5s — see `BILLING_DECISION_NOTIFICATION_*` in
`backend/api/src/common/queues/queue-names.ts`).

## Owner decision 2026-10-15T16:33:05Z — why Resend, not plain SMTP

Plain SMTP cannot atomically coordinate "the relay accepted this message" with "our
database recorded that it did": the three operations check-current-state / send /
mark-delivered leave an irreducible crash window between a successful SMTP transaction
and the durable marker commit. Resending there risks a duplicate; marking before sending
risks silently losing a notification the relay never actually accepted. No ordering of
those three steps over plain SMTP closes that gap — this is a transport-ownership
limitation, not a coding bug (full analysis: Codex review `t070-review-31b5dd9` and
technical arbiter escalation `t070-technical-arbiter-20261015T0148Z`).

The fix moves the delivery-acceptance boundary onto a provider with a documented,
atomic, application-supplied **Idempotency-Key**
(https://resend.com/docs/dashboard/emails/idempotency-keys): every send for a given
decision occurrence carries the SAME deterministic key
(`kemfai/notification.billing_decision/<outbox-row-id>` — see
`resendIdempotencyKey`, `backend/api/src/modules/billing-admin/resend-idempotency-key.ts`),
derived only from the outbox row's own immutable `id`, never from mutable state. Resend
retains that key for 24h: a replay with the identical payload returns the identical
result (no new email); a replay with a different payload is rejected 409 (fail-closed).
That turns "did the provider actually accept this?" into a question the provider itself
answers deterministically on retry, instead of something KEMFAI has to guess at a crash
boundary.

A stable key alone is not enough: the retried BODY must also be byte-identical, or the
provider's own fail-closed 409 fires on a perfectly legitimate retry. Re-rendering the
email from current state on every attempt cannot guarantee that — `account.preferred_
locale` (or any other input the renderer reads) could legitimately change between a
crashed attempt and its retry. So the complete serialized provider request — `from`,
`to`, `subject`, and `text` — is persisted in `provider_request_body` ONCE, atomically
alongside `first_send_attempted_at` (same guarded `UPDATE`, same `COALESCE`
idiom), and every attempt — including the very first, and including a concurrent
processor that raced and rendered something different — sends back exactly what is
already durably persisted, never a fresh render. This is provable byte-identical
payload reuse, not an assumption that two renders happen to agree.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `RESEND_API_KEY` | yes for delivery | Resend API key, sent as `Authorization: Bearer <key>` |
| `RESEND_FROM` | yes for delivery | From header, e.g. `KEMFAI Billing <billing@kemfai.example>` |
| `RESEND_BASE_URL` | no | Defaults to exactly `https://api.resend.com` (no alternate port/path/query/fragment); overridable only to explicit `http://` loopback with `RESEND_ALLOW_LOOPBACK_FIXTURE=1` for tests |

Transport security invariant: the API key is a bearer credential. Production sends are
allowed only to the exact bare origin `https://api.resend.com`, and redirects are
refused. The explicit test opt-in accepts only an `http://` loopback origin. See
`assertSafeBaseUrl` in `billing-decision-notification-transport.ts`.

Same-occurrence idempotency: the durable `delivered_at`/`provider_message_id` marker on
the occurrence's outbox row is the delivery boundary, written only after the provider
CONFIRMED acceptance. Any later replay of the same occurrence (redelivery, manual
reprocess, retry after a crash that followed the marker write) is a silent no-op. A
crash, lost acknowledgment, or two overlapping processors between the provider's
acceptance and the marker write all retry with the SAME idempotency key — Resend
collapses them to the SAME accepted email, never a duplicate (see
`billing-decision-notification-delivery.integration-spec.ts` for the crash/lost-ack/
concurrency proofs).

Terminal markers are mutually exclusive (enforced by a database CHECK) and reconcile
by evidence precedence. Confirmed provider acceptance is authoritative: `delivered_at`
atomically clears a concurrently written rejection/quarantine marker. A concrete 409
supersedes quarantine but cannot overwrite delivery. Quarantine is lowest precedence
and only claims a row with neither delivery nor rejection. Thus a sweep cannot hide an
accepted in-flight request.

Two terminal, non-delivered outcomes exist and are NEVER retried under a fresh key
(`UnrecoverableError` — no further BullMQ retries):

- **`delivery_rejected_at`** — the provider answered 409 for the occurrence's own key
  (a payload mismatch on replay; should not happen absent a bug).
- **`quarantined_at`** — an ambiguous (not-yet-confirmed-delivered) occurrence crossed
  the conservative retry cutoff (23h since the first attempt — 1h of safety margin
  before Resend's documented 24h key retention closes) without confirmed delivery.
  Resending right at/after that boundary risks the provider treating the SAME key as
  expired and accepting a genuine duplicate — exactly what this design exists to
  prevent.

Both require explicit manual reconciliation (check the Resend dashboard/API by the
occurrence's `provider_message_id` if one was ever recorded, or by recomputing the
deterministic key from the outbox row's `id`) — never an automatic resend under a new
key, which would defeat the whole point of a stable per-occurrence key.

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
healthy steady state is zero `waiting`/`failed` jobs; `failedReason` contains only a
sanitized category and bounded allowlisted metadata (for example HTTP status), never a
raw provider/network error, credential, address, subject, or message body. It records
provider refusal, timeout, misconfiguration, or an
`UnrecoverableError` for a terminal `quarantined_at`/`delivery_rejected_at` occurrence
(see below). Successful deliveries are also logged by the processor
(`billing decision notification delivered: submission … (decision, occurrence …)`).

Quarantined or payload-rejected occurrences (never auto-resolved — see "Owner decision"
above):

```sql
SELECT id, job_id, submission_id, decision, provider_message_id, quarantined_at, delivery_rejected_at
  FROM billing_decision_notification_outbox
 WHERE quarantined_at IS NOT NULL OR delivery_rejected_at IS NOT NULL;
```

A healthy steady state is zero rows. Any row here needs a human to check the Resend
dashboard/API for the occurrence's deterministic key
(`kemfai/notification.billing_decision/<id>`) before deciding whether the customer was
actually notified — never an automatic resend under a new key.

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
