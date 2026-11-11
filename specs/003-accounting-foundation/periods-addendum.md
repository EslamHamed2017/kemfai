# Story 7 Addendum — Accounting Period Lifecycle

**Feature:** `003-accounting-foundation`
**Addendum version:** 1.0
**Status:** INDEPENDENTLY REVIEWED — specification accepted; no implementation or production activation authorized
**Policy authority:** `accounting-policy-matrix.md` v1.0, approved 2026-11-07
**Prerequisites:** `posting-addendum.md` v1.0, independently reviewed
**Scope:** User Story 7 only: company accounting-period creation, transition, and authorized reopening
**Independent review:** Codex — ACCEPT; verified against T158, matrix v1.0, Story 7, dependent addenda, and repository guardrails

## 1. Purpose and gate

This addendum specifies the future contract, domain model, effective-time rules, matrix lookup, transition and reopening authorization, concurrency controls, audit evidence, and owned-live proof required by T158. It creates no runtime route, model, migration, executable implementation task, feature enablement, or acceptance claim. Executable work may be commissioned only after independent review accepts this document and a new tests-first task graph is generated.

The lifecycle is exactly `Open → Soft Close → Finance Review → Hard Close`, with authorized, reasoned, audited reopening. Period maintenance never edits ledger history. Posting, reversal/correction, and opening posting consume a locked period evaluation through their separately reviewed boundaries; this addendum does not weaken those boundaries.

## 2. Normative invariants

1. Each period belongs to exactly one authenticated tenant/company and covers one inclusive accounting-date interval in that company's configured calendar and timezone.
2. Period ranges for one company cannot overlap. There must be exactly one effective period for an accounting date before a policy-dependent ledger action can proceed; gaps and overlaps fail closed.
3. State is exactly `open|soft_close|finance_review|hard_close`. A normal transition moves one step forward only. Reopening moves one step backward only; reaching an earlier state requires separately authorized, separately audited steps.
4. Creating a period starts it in `open`. State cannot be supplied as another value, backdated through system-clock manipulation, or changed by generic update.
5. The server resolves the applicable approved matrix and versioned company action configuration at the command's company-effective time. Clients cannot supply matrix, effective-time, permission, approval, or rule results.
6. Matrix v1.0 fixes ledger-action behavior in each state. Company configuration may identify specifically authorized adjustment classes, permission keys, and Maker–Checker criteria only within that matrix; it cannot permit routine posting in Soft Close, bypass Maker–Checker in Finance Review, or permit posting/reversal/correction in Hard Close.
7. Transition and reopening authority is separate from `Post`, `Reverse`, `Correct Posted Entry`, and ordinary accounting `Edit`. Reopening requires its own permission and a mandatory nonblank reason. Forward transitions require an explicit human confirmation and a reason only when the effective versioned configuration requires one; this addendum infers no additional reason rule for any forward edge.
8. Every successful create, transition, or reopen appends immutable period history and tenant audit records in the same transaction. No history row may be edited or deleted.
9. A period mutation and every consuming ledger command for that company serialize through one company-wide period-selector lock and monotonic selector version. Under that lock, a consumer resolves its accounting date to exactly one period as required by `posting-addendum.md`. Either the period mutation commits first and the ledger command re-evaluates, or the ledger command commits first with its immutable period snapshot.
10. Exact idempotent replay returns the prior receipt/result. Changed-fingerprint reuse conflicts. Simultaneous distinct commands against one version produce one winner and deterministic audited losers.
11. Tenant-audit or receipt failure rolls back the period mutation. Platform-mirror failure withholds success and recovery mirrors the immutable tenant outcome without another state change.
12. Period capability defaults false. Disabled means mutation routes are unmounted and capability is false; matrix approval or addon installation alone cannot enable it.

## 3. Boundary and future contract

Every customer call follows browser → Next.js BFF → NestJS → guarded Odoo ORM → the authenticated tenant's exact database. Public payloads use KEMFAI UUIDs only. Native model names, integer IDs, database names, RPC details, and Odoo URLs never cross the boundary.

A future additive contract may expose only:

| Method and path | Purpose | Success |
|---|---|---|
| `GET /v1/accounting/periods` | List authorized company periods and immutable state summaries. | `200` |
| `POST /v1/accounting/periods` | Create one non-overlapping period in `Open`. | `201`; `200` exact replay |
| `GET /v1/accounting/periods/{periodId}` | Read one authorized period and append-only history. | `200` |
| `POST /v1/accounting/periods/{periodId}/transition` | Move exactly one step forward after execution-time checks. | `201`; `200` exact replay |
| `POST /v1/accounting/periods/{periodId}/reopen` | Move exactly one step backward with separate permission and mandatory reason. | `201`; `200` exact replay |

There is no generic state update, PUT/PATCH/DELETE, bulk close/reopen, direct matrix override, native action endpoint, or ledger rewrite route.

### 3.1 Preconditions and payloads

Mutations require authenticated human context, `X-KEMFAI-Company-Id`, `Idempotency-Key`, correlation context, and exact strong `If-Match` for transition/reopen. Wildcard preconditions are rejected.

Create accepts only `name`, inclusive `dateFrom`, inclusive `dateTo`, and human `confirmation: CREATE PERIOD`. The server derives company, timezone, initial state, actor, effective time, and policy context.

Transition accepts only `targetState`, `confirmation: TRANSITION PERIOD`, and optional `reason`; `targetState` must be the immediate successor. Reopen accepts only `targetState`, `confirmation: REOPEN PERIOD`, and mandatory nonblank `reason`; `targetState` must be the immediate predecessor. Clients cannot submit prior state, actor, permission, approval, matrix/configuration version, selector version, effective time, ledger facts, or audit fields.

### 3.2 Stable outcomes

- `401/403`: unauthenticated or unauthorized, with opaque foreign-resource behavior.
- `404`: absent or out-of-scope public resource without existence disclosure.
- `409`: idempotency fingerprint conflict, invalid transition edge, overlapping range, stale approval/configuration, concurrent terminal-state conflict, or selector conflict.
- `412`: ETag/version mismatch.
- `422`: invalid dates, missing mandatory reason/confirmation, failed close controls, unresolved matrix/action configuration, or blocked effective rule.
- `503`: authoritative tenant mutation/audit outcome cannot be proven; success is withheld and recovery remains safe.

Errors use stable KEMFAI codes, localized message keys and parameters, optional field paths, and no native details. Failed outcomes leave period state, selector version, ledger, balances, and history unchanged.

## 4. Effective time, matrix, and action configuration

### 4.1 Effective time

Accounting-date ledger evaluation uses the requested entry accounting date and cannot be altered by system time. Period-maintenance commands instead use one server-derived **company-effective instant**: the authoritative transaction timestamp converted through the company's snapshotted IANA timezone and mapped to its local effective date. The client cannot supply or override it. The command retains UTC instant, timezone identifier/version, local effective date/time, and monotonic transaction ordering token.

A retry or recovery reuses the original operation's retained effective instant. A changed system clock, timezone configuration race, delayed approval, or later recovery cannot move the operation to another effective rule. A timezone configuration mutation serializes through the company selector lock; whichever commits first determines the immutable snapshot.

### 4.2 Matrix lookup

Under the company/localization/effective-date policy selector lock, the server resolves exactly one approved applicable matrix version. Zero, multiple, pending, superseded-without-successor, or hash-invalid results fail closed. The period command retains matrix UUID, version, scope, effective date, canonical hash, selector version, and the exact period-control row used.

Matrix v1.0 supplies the non-overridable state behavior. Period-transition configuration is separate versioned company data defining permission keys, forward-transition close controls, reason requirements, approval criteria, and registered adjustment-class mappings. Exactly one effective configuration must resolve. Unknown rule keys, overlapping applicability, invalid parameters, or a configuration that weakens the matrix fail closed.

Configuration and matrix applicability mutations acquire the company-wide period-selector lock before their own selector locks and increment the applicable selectors. A command re-resolves immediately before state mutation. Immutable prior history retains its original snapshots and is never rewritten by later policy changes.

## 5. Authorization, transitions, and reopening

- `View` reads company-scoped periods/history.
- `Create Accounting Period` creates a non-overlapping Open period.
- `Transition Accounting Period` permits a configured immediate forward edge only after its close controls pass.
- `Reopen Accounting Period` is a distinct permission required for every backward edge.
- `Approve Accounting Period Change` is required when the effective configuration applies Maker–Checker. The maker cannot approve their own command.

`Post`, `Reverse`, `Correct Posted Entry`, ordinary `Edit`, and general company administration imply none of these grants. Grants are server-derived and company/action scoped.

The only forward edges are Open→Soft Close, Soft Close→Finance Review, and Finance Review→Hard Close. The only reopening edges are Hard Close→Finance Review, Finance Review→Soft Close, and Soft Close→Open. Skips, same-state commands, arbitrary backward transition, reopening through the transition route, and forward movement through the reopen route are rejected.

Forward close controls are allow-listed, versioned, deterministic checks over persisted company facts. They may block but cannot mutate ledger state. Configuration identifies required check keys and parameters; this addendum invents no universal reconciliation checklist. Missing/unknown checks or unavailable evidence fail closed. No forward edge has an inferred reason requirement; a reason is mandatory only when the effective versioned configuration requires it.

Every reopening requires a nonblank reason and separate permission. Reopening never changes, unlocks, deletes, or reposts existing entries; it only changes the effective rule for later separately authorized actions. A later posting/reversal command must independently re-evaluate the new state and matrix.

When Maker–Checker applies, the initial command freezes period/version, target edge, effective-time/matrix/configuration/check snapshots, maker, reason, and fingerprint with zero state change. A distinct checker revalidates permissions, current period/version, selector versions, checks, matrix, and configuration before atomically applying the edge. Changed facts make the candidate stale and require a new command. No rejection/cancellation command is specified here.

## 6. Domain model

### 6.1 Accounting period

A future company-scoped period retains public UUID, name, inclusive start/end dates, current state, concurrency version, selector version, company timezone snapshot, creator, latest transition, and immutable creation/update timestamps. Database exclusion/constraint enforcement prevents overlapping ranges per company.

The current-state projection is derived only by guarded commands. It cannot be updated or deleted directly. A period referenced by history or ledger snapshots cannot be deleted; this addendum defines no delete operation for any period.

### 6.2 Append-only history

Each successful creation, transition, or reopening appends one history record with its own UUID; action `created|transitioned|reopened`; previous/new state; period version before/after; actor and maker/checker where applicable; mandatory/optional reason; UTC and company-effective timestamps; timezone snapshot; matrix/configuration/check snapshots and hashes; selector versions; human operation UUID; idempotency fingerprint; correlation; audit event; and receipt.

A database constraint and guarded service permit one successor history row per prior period version. History rows are append-only and immutable. Creation history has no previous state and new state Open. Reopening history remains distinguishable from ordinary forward transition history.

### 6.3 Approval candidate and selector

A period-change approval retains status `pending|applied|stale`, frozen edge/snapshots, maker/checker, reason, operation references, and linked history/receipt/event after application. At most one non-stale candidate exists for one period version and edge.

The company-wide period selector retains one monotonic version per company. Create, transition, reopen, relevant calendar/timezone mutation, and any action-configuration applicability change acquire the same company-wide lock and increment the appropriate version in the same transaction. Posting/reversal/opening consumers retain the version they evaluated.

## 7. Atomicity, concurrency, and recovery

Create locks the company-wide period selector before calendar/range overlap validation. Transition/reopen lock in deterministic order: company-wide period selector, policy/configuration selectors, period row/version, approval candidate where applicable, then tenant receipt/audit. Posting, reversal, and opening commands first acquire that same company-wide period-selector lock, read its monotonic version, and resolve their accounting date to exactly one period before any ledger lock. A transition over any date range therefore conflicts with every concurrent consumer for that company; there is no per-date lock gap. Consumers of different companies remain independent.

A period mutation commits current state/version, selector increment, immutable history, approval terminal state when applicable, tenant audit event, and receipt together or none. It never shares a transaction with posting merely because both race; lock ordering determines which executes first and the loser re-evaluates.

True two-connection tests must prove create overlap races, same-key replay races, distinct-key same-version transition races, transition-versus-reopen races, maker-versus-checker races, and period mutation versus posting/reversal/opening evaluation. Sequential stale requests do not satisfy concurrency proof.

A lost response is recovered from the immutable tenant receipt using the original human operation UUID. Recovery may finish platform mirroring but cannot originate an action, substitute an actor/checker, choose a new effective instant, re-run the transition, or increment the selector twice.

## 8. Audit contract

Every attempt records actor, tenant/company, period/range/version, action and edge, reason requirement/result, permission/approval result, effective-time/timezone snapshot, matrix/configuration/check snapshots, selector versions, idempotency fingerprint, correlation, outcome, stable reason code, and timestamps.

Pre-domain opaque denials are authoritative control-plane audit events. Domain denials and successes are tenant events mirrored to the platform. Exact replays reference the original receipt/event and append one deduplicated platform replay event per replay correlation; they do not append another tenant mutation history/event. Fingerprint conflicts, stale versions, failed checks, unauthorized attempts, and invalid edges are audited without state change.

History and audit are both required: history proves the period lifecycle; audit proves attempts and outcomes. Neither substitutes for the other.

## 9. UI and accessibility

The workspace presents period ranges, current state, matrix/configuration status, immutable timeline, and only the next authorized action. Transition/reopen confirmation names the exact edge, effective company time, effects on future actions, required checks/approval, and makes clear that posted history is unchanged.

Empty/loading/error/retry/stale/pending-approval/recovery states preserve accepted input and prevent duplicate submission. Reason fields expose requirement and validation accessibly. EN/LTR and AR/RTL journeys support keyboard-only operation, visible focus, timeline/table semantics, live status/error summaries, and 200% zoom. AI may explain states or checks but cannot create, transition, reopen, approve, or post.

## 10. Test-first implementation gate

A future task graph must place all tests before first Story 7 implementation and include:

- contract tests for exact routes/schemas, headers/ETags, stable errors, disabled-route absence, and no native leakage;
- Odoo tests for non-overlap, exact edges, effective time, matrix/configuration lookup, permissions, reasons, approvals, immutable history, selector versions, receipt/audit rollback, and no ledger mutation;
- true two-connection races for overlapping create, keys, edges, approval, timezone/policy/configuration changes, and posting/reversal/opening consumption;
- Nest real-RPC integration for opaque tenant/company denial, lost response, lease recovery, mirror outage, and exactly-once outcomes;
- EN/AR/RTL frontend unit/accessibility tests and no-interception browser journeys; and
- fail-closed evidence-validator tests observed red before fixture/evidence implementation.

No implementation may merge unless the required branch-protection check is externally enforced and green.

## 11. Owned-live acceptance corpus

Final acceptance uses exact-owned control PostgreSQL, Redis, Keycloak, production Nest/Next, real Odoo, and at least two routed tenant databases on dynamic loopback ports. Through the browser production path it proves:

1. Authorized creation produces one non-overlapping Open period and immutable creation history; overlap, gap-dependent ledger evaluation, invalid range, unauthorized, wrong-company, and foreign-tenant requests change nothing.
2. The exact forward lifecycle reaches Soft Close, Finance Review, and Hard Close one edge at a time with retained effective-time, timezone, matrix/configuration/check, actor, reason, receipt, and audit evidence.
3. Each reopening moves one edge backward with distinct permission and mandatory reason, preserves all prior history, and never changes existing ledger rows or balances.
4. Open allows authorized configured actions; Soft Close blocks routine posting and permits only specifically authorized reasoned adjustments; Finance Review requires approved adjustment Maker–Checker; Hard Close blocks posting/reversal/correction. Tests resolve classifications/configuration rather than infer them.
5. Changing system time cannot bypass accounting-date evaluation. Timezone, matrix, and configuration races either win before re-resolution or lose after the immutable snapshot.
6. Maker–Checker has no state effect before a distinct authorized checker acts; self-approval, stale approval, duplicate approval, and changed selector facts cannot apply an edge.
7. Same-key simultaneous requests, lost-response recovery, and at least 100 exact replays produce one state/history/tenant event; changed-payload reuse conflicts. Distinct-key same-version commands produce one winner.
8. True concurrent period transition/reopen versus posting, reversal, and opening evaluation proves deterministic selector-lock ordering and no action executes under stale period state.
9. Tenant-audit or receipt injection rolls back state/history/selector/approval changes. Platform-mirror failure withholds success and recovery creates one mirror without another state transition.
10. A real foreign UUID is denied opaquely; both tenant DBs prove unchanged foreign period and ledger hashes.
11. EN and AR/RTL keyboard journeys pass at 200% zoom for lifecycle, reason, approval, conflict, denial, and recovery states.
12. Exact-owned cleanup removes only registered resources and leaves zero processes, containers, networks, volumes, databases, realms/clients, routes, private files, or mutated shared state.

Persisted evidence includes before/after period, history, selector, approval, move, line, balance, receipt, and audit hashes/counts for both DBs; exact UUIDs/versions/snapshots; synchronized race facts; effective-time/timezone facts; failure-injection checkpoints; route/capability probes; timing; ownership registry; secret scan; cleanup receipts; and zero survivors. The independent validator rejects response-only, screenshot-only, direct-model-only, mocked, intercepted, sequential-race, retried, skipped, flaky, transformed, partial, or survivor-tolerant evidence.

## 12. Release and rollback

Period-maintenance capability is company/tenant release data, defaults false, and depends on the accepted Story 4 posting contract/addon/schema plus this independently reviewed Story 7 contract/addon/schema. It may be enabled only after completed automated tests, independently validated owned-live acceptance, an externally enforced green required branch-protection check, and recorded release approval. Reversal and opening implementations consume period evaluation when enabled but are not prerequisites for safely maintaining periods. Disabled means all period mutation routes are unmounted and capability is false; scoped reads may remain unavailable until the same release gate passes.

Operational rollback disables new commands and reconciles already authorized operations from immutable receipts. It never deletes or rewrites periods, history, approvals, ledger entries, policy snapshots, receipts, or audit evidence. Down migrations that could discard those records are prohibited.

## 13. Explicit exclusions

This addendum does not define fiscal-calendar generation, arbitrary/custom period states, bulk year-end close, permanent lock dates outside the four-state lifecycle, automated close scheduling, tax-return locks, consolidation, country-specific close checklists, rejection/cancellation commands, ledger posting/reversal/opening implementation, or autonomous AI actions. Such workflows require separately reviewed specifications and cannot weaken this lifecycle.

## 14. Independent review checklist

The reviewer must confirm:

- effective company time, timezone snapshot, accounting-date evaluation, exact matrix/configuration lookup, and selector-lock composition with `posting-addendum.md` are deterministic;
- only the four locked states and immediate forward/reopening edges exist, permissions are separate, and mandatory reopening reasons plus only configured forward-transition reasons are represented without inventing a universal close checklist;
- immutable history, Maker–Checker where configured, true races, audit/receipt rollback, recovery, tenant isolation, release gating, no-ledger mutation, and exact cleanup evidence are complete;
- Stories 4–6 contracts are consumed without modifying their ledger semantics or falsely claiming implementation/acceptance;
- no runtime route, model, task graph, flag, acceptance status, or production capability is enabled by this document; and
- ambiguities are resolved before T158 is checked complete.
