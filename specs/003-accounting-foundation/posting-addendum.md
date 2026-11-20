# Story 4 Addendum — Authorized Double-Entry Posting

**Feature:** `003-accounting-foundation`
**Addendum version:** 1.1
**Status:** SPECIFICATION AMENDMENT CANDIDATE — exact-content independent re-review and protected PR approval required; no implementation or production activation authorized
**Policy authority:** `accounting-policy-matrix.md` v1.0, approved 2026-11-07
**Scope:** User Story 4 only: approval-aware posting of an existing KEMFAI journal draft
**Review binding:** v1.0 was independently accepted under T152; v1.1 must be independently reviewed as exact content at the graph-review head, and any amendment invalidates that evidence

## 1. Purpose and gate

This addendum specifies the contract, domain model, atomic transaction boundary, and live-proof requirements required by T152. It does not create routes, models, implementation tasks, feature enablement, or acceptance evidence. Executable work may be commissioned only after this addendum passes independent review and the task graph is regenerated with tests-first barriers.

Story 5 reversal/correction, Story 6 opening balances, and Story 7 period maintenance remain separately gated. Posting may *evaluate* the effective period state through the interface defined here, but this addendum does not define period creation, transition, close, or reopen commands.

## 2. Normative invariants

1. One posted ledger exists per company in the routed tenant Odoo database. A successful post creates exactly one native `account.move` and its lines in that database.
2. A post is an explicit action attributable to an authenticated human with `Post` permission. AI, schedulers, recovery workers, and service identities may resume an already authorized operation but cannot originate authorization.
3. All header, line, journal, account, currency, dimension, source, policy, period, approval, actor, and company references resolve in the authenticated tenant and selected company before ledger mutation.
4. Base-currency debit equals base-currency credit exactly. At least two lines are required. Every line has exactly one positive debit/credit side and an active posting account.
5. Posting is atomic: move, lines, immutable source links, matrix snapshot, dimension snapshots, tenant audit event, and mutation receipt commit together or none commit.
6. A posted move is immutable through KEMFAI. No update or delete route exists. Correction is exclusively Story 5.
7. The exact applicable Accounting Policy Matrix version is evaluated at execution time and retained on the posted move. v1.0 is the only approved version for this addendum; absent, inapplicable, superseded-without-effective-resolution, or changed policy fails closed.
8. Period permission is evaluated against the draft accounting date at execution time. System-clock changes cannot select another period.
9. Idempotent replay returns the original outcome. A changed fingerprint under the same scoped key conflicts and cannot create another move, approval, receipt, or event.
10. `module.accounting_posting` remains absent/false until the complete implementation passes independent acceptance and release approval. Disabled capability means route absence, not only UI hiding.

## 3. Boundary and routes

All customer calls follow browser → Next.js BFF → NestJS → guarded Odoo ORM → exact tenant DB. Public identifiers are UUIDs; native model names, integer IDs, database names, RPC details, and Odoo URLs never cross the API boundary.

A future additive OpenAPI contract may expose only these seven Story 4 operations:

| Method and path | Purpose | Success |
|---|---|---|
| `GET /v1/accounting/drafts/{draftId}/posting-preview?validationRunId={validationRunId}` | Authorized maker reads a non-mutating, server-rendered posting-impact preview for one exact draft version/validation run, with the exact strong draft ETag and canonical `previewDigest`; it never posts, creates an approval, or mutates the draft. | `200` |
| `POST /v1/accounting/drafts/{draftId}/post` | Human requests posting of one exact preview-bound draft version. It either posts immediately or creates/replays a required approval request. | `201` posted; `202` approval required; `200` exact replay |
| `GET /v1/accounting/posting-approvals?status=pending` | An authorized checker discovers only pending approvals within their tenant, selected company, `Approve` permission, and amount scope; results contain public UUIDs and summary evidence only, use stable cursor pagination, and never claim or mutate an approval. | `200` |
| `GET /v1/accounting/posting-approvals/{approvalId}` | Authorized maker or distinct in-scope checker reads the immutable frozen candidate and current non-mutating preview evidence required for review; this operation never claims, approves, posts, or mutates the candidate. | `200` |
| `POST /v1/accounting/posting-approvals/{approvalId}/approve` | Distinct authorized checker approves and atomically posts the frozen candidate. | `201` posted; `200` exact replay |
| `GET /v1/accounting/posted-entries/{entryId}` | Read immutable KEMFAI entry, source, dimensions, policy and audit links within scope. | `200` |
| `GET /v1/accounting/sources/{sourceId}/posted-entries` | Resolve an authorized KEMFAI source UUID to immutable posted-entry links; the draft UUID is always a valid canonical source. | `200` |

No generic native action endpoint is permitted. There is no posted-entry PUT/PATCH/DELETE. Story 5 routes are not introduced here.

### 3.1 Command headers

Mutation commands require authenticated user context, `X-KEMFAI-Company-Id`, `Idempotency-Key`, `If-Match` with the exact strong draft or approval ETag, and correlation context. The server derives tenant and actor. Wildcard preconditions are rejected. The strong approval ETag covers the preview digest inputs and every mutable policy, period, approval-configuration, master-data, dimension, source, FX, rounding, candidate, selector, and authority version used to produce the checker-visible preview. The strong draft ETag covers the corresponding digest inputs and mutable versions used to produce the maker-visible immediate-post preview.

### 3.2 Post request

The body contains only:

- `draftVersion`: exact integer version duplicated for explicit signing/fingerprinting;
- `validationRunId`: immutable validation result for that draft version;
- `previewDigest`: exact opaque canonical digest returned with the server-rendered posting-impact review for that draft version and validation run;
- `confirmation`: literal `POST` supplied by the human confirmation UI;
- `reason`: required when the effective period rule or configured approval rule requires one.

Client-supplied matrix versions, Odoo IDs, calculated totals, permission claims, approval decisions, or period states are rejected. The server resolves and snapshots them. The post request body includes the exact `previewDigest`; the immediate-post preview and confirmation use the same domain-separated, contract-versioned canonical serialization as approval review, covering the complete human-visible preview and every mutable input/version that can affect posting. Under the guarded transaction, the server first compares the submitted `If-Match` and `previewDigest` with the immutable server-issued preview record reconstructed from the exact draft version, validation run, and ETag-bound version vector. Only a mismatch at that client-binding step returns `412`. After those preconditions match, the server acquires the shared selector locks, re-resolves current facts, and recomputes the preview and digest: changed but still valid preview inputs return `409` and require a fresh preview; invalid execution facts return `422` with ordered validation issues; every outcome creates zero ledger state. This ordering is normative, so a current-state drift is never reclassified as a client-binding mismatch. Exact replay returns only the original terminal outcome.

### 3.3 Approval review and command binding

The pending collection and approval-detail reads are non-mutating and scope-filtered. The detail response returns the exact frozen candidate, current preview evidence, a strong approval ETag, and a server-generated canonical `previewDigest`. The digest is computed from a domain-separated, versioned canonical serialization of the approval public ID/version, candidate fingerprint, complete checker-visible preview payload, and every policy, period, approval-configuration, master-data, dimension, source, FX, rounding, selector, and authority version that can affect approval-time posting. The canonical serialization and digest algorithm are contract-versioned; clients never construct or alter the digest.

The approval command body includes the exact `previewDigest` returned by the detail read and a literal `confirmation: APPROVE`; no calculated amount, policy decision, or approval result is accepted from the client. The `If-Match` value and `previewDigest` jointly bind the human confirmation to one exact server-rendered preview. Under the guarded posting transaction and selector locks, the server re-resolves all mutable facts and recomputes both the preview and digest. An ETag or digest mismatch cannot post: stale preconditions return `412`; changed or invalid execution facts atomically mark the candidate `stale`, return the stable conflict outcome, and produce zero ledger effect. Exact idempotent replay returns only the original terminal outcome.

### 3.4 Outcomes and stable errors

- `401/403`: unauthenticated or unauthorized, with opaque foreign-resource behavior.
- `404`: absent or out-of-scope public resource; no existence disclosure.
- `409`: idempotency fingerprint conflict, stale/non-current validation, already terminal draft, duplicate approval chain, or immutable-state conflict.
- `412`: exact strong ETag or canonical `previewDigest` mismatch.
- `422`: complete ordered validation issues, including unbalanced base totals, non-posting/inactive account, inactive journal/currency, missing/invalid dimensions, incomplete FX provenance, excess-scale/rounding policy failure, disallowed period, unavailable policy, maker-checker self-approval, or source-scope failure.
- `503`: authoritative mutation or audit completion cannot be proven; success is withheld and recovery remains safe.

Errors use stable KEMFAI codes, localized message keys/parameters, optional line/field paths, and no native details. A failed outcome proves zero new move/line/balance/source rows.

Every attempt has immutable audit evidence. A denial before tenant routing/domain entry is recorded in the control-plane audit as the authoritative denial event with opaque submitted identifiers, actor/company scope, reason code, idempotency key hash, and correlation ID. A denial evaluated inside the tenant domain is written to the tenant audit and mirrored to the platform. An exact idempotent replay references the original receipt/event and appends one deduplicated `posting.replayed` platform event per replay correlation ID; it creates no second tenant mutation event. Fingerprint conflicts and stale requests are independently audited as denied attempts.

## 4. Authorization and maker-checker

`Post` is separate from draft `Create`/`Edit`; `Approve` is separate from `Post`. Company and amount scopes are enforced from server-side grants.

The company approval configuration is versioned data. It may activate maker-checker by amount or another configured criterion; this addendum hard-codes no threshold or criterion. A configuration row names a registered criterion key, effective date range, company/localization scope, priority, typed criterion parameters, maker/checker permission keys, amount-scope basis, and reason requirements. Criterion implementations are allow-listed, deterministic, side-effect free, and consume only the canonical candidate snapshot plus authenticated server context. Unknown criterion keys or invalid parameters fail closed.

An approval resolver selects exactly one effective configuration under a company-scoped approval-selector lock. Exactly one effective configuration is mandatory and explicitly sets `makerCheckerEnabled: true|false`. Absence, multiple matches, overlapping ranges, unknown criteria, or evaluator errors block posting. Only an explicit effective `false` permits immediate posting; `true` requires approval. The exact configuration ID/version, criterion key/parameters, canonical inputs, and result are frozen with the candidate. Approval-configuration mutations acquire the same selector lock and increment the selector version, so either the mutation wins and the post evaluates the new version, or the post wins and retains the old immutable snapshot; an approval decision re-resolves and marks the candidate stale if the selector version changed.

When maker-checker does not apply, an authorized human post request may execute atomically. When it applies:

1. the post request freezes the exact draft version, validation run, fingerprint, policy, period evaluation, source, totals, and configuration snapshot;
2. no ledger movement occurs and a `pending` approval is returned;
3. the maker cannot approve their own request; this addendum defines no rejection or cancellation command;
4. a checker needs `Approve` plus applicable company/amount scope;
5. approval re-evaluates mutable execution facts, including permissions, policy applicability, period state, master activity, and draft/candidate integrity;
6. any changed draft or invalidated snapshot makes the candidate stale and requires a new request; and
7. a changed or invalid candidate becomes `stale` without ledger effect; rejection and cancellation behavior is outside this addendum.

Recovery may resume an approval or post authorized by the recorded human operation UUID, but may not manufacture confirmation or substitute an actor.

## 5. Domain model

### 5.1 Posted entry mapping

A successful operation creates one native posted `account.move` through a guarded KEMFAI service. KEMFAI extensions retain:

- immutable `kemfai_public_id`, company, accounting date, journal, description and status `posted`;
- source type/public ID and immutable bidirectional source-link public ID;
- draft public ID/version and validation-run public ID;
- matrix public ID/version/effective date/scope and canonical snapshot hash;
- period public ID/state/version and evaluated rule result;
- approval configuration/version and approval public ID when applicable;
- authorization actor, operation UUID, idempotency fingerprint, correlation ID and timestamps;
- exact base debit/credit totals and currency metadata; and
- tenant audit-event and receipt public IDs.

Each native move line retains an immutable KEMFAI UUID, source draft-line UUID, posting account, exact transaction/base amounts, currency/rate provenance and metadata snapshots, and normalized dimension assignments. Native numeric projections must round-trip to the accepted exact values; any representational loss blocks before creation.

### 5.2 Posting approval

`kemfai.account.posting.approval` is company-scoped and immutable except for one guarded terminal transition:

- status `pending|approved|stale`;
- maker/checker identities and timestamps;
- frozen candidate fingerprint and all versions listed above;
- configured criterion evaluation and required reason;
- linked posted-entry/receipt/event IDs when approved; there is no rejection/cancellation transition in this addendum.

A database constraint permits at most one non-stale approval chain per draft version and candidate fingerprint. The approving checker and maker must differ when approval is required.

### 5.3 Source link

`kemfai.account.source.link` stores company, source type/public ID, posted entry public ID, relationship `origin`, and immutable operation/audit metadata. Every post has at least one source: the originating draft UUID is the mandatory canonical source. Optional business-source fields add further links only when present and authorized. Source ownership is verified before posting. Entry→source uses the posted-entry read; source→entry uses `GET /v1/accounting/sources/{sourceId}/posted-entries`. Both directions use KEMFAI UUIDs, ordinary authorization, opaque foreign denial, and no native identifiers.

### 5.4 Policy and period evaluators

Posting consumes two fail-closed interfaces:

- **Policy resolver:** under a company/localization/accounting-date selector lock, returns one applicable approved matrix version, including canonical values/hash and selector version. Zero or multiple results block. Every policy applicability mutation acquires the same lock and increments the selector version. If it commits first, posting evaluates the new version; if posting commits first, the immutable old snapshot governs that operation and the later change cannot rewrite it. Serializable-conflict losers retry resolution before any ledger write.
- **Period evaluator:** under a company/accounting-date selector lock, returns exactly one period containing the accounting date, its immutable state/version, selector version, entry classification, required permission/configuration evidence, maker-checker requirement, reason requirement, and rule evidence. Zero periods, overlaps, unknown states/classes, missing configuration, or resolver errors block. Every period create/state/transition/reopen mutation must acquire the same selector lock and increment the selector version. If a period mutation commits first, posting re-evaluates the new state; if posting commits first, its immutable snapshot governs. Serializable-conflict losers retry evaluation before any ledger write.

Entry classification is data-driven: a versioned company configuration maps the draft `transactionTypeKey` to `routine` or `adjustment`, with an adjustment permission key and approved workflow key. Unknown or overlapping mappings block. Open accepts either class subject to ordinary posting authority. Soft Close accepts only `adjustment` plus the mapped specific permission and a reason. Finance Review accepts only `adjustment` plus that permission, reason, and a completed maker-checker approval under the mapped workflow. Hard Close always blocks. No transaction type is hard-coded as an adjustment.

This addendum does not define who may transition or reopen periods; it only consumes the locked, versioned result above. Every posting-path resolution uses shared mutation-compatible selector/version locks for policy, period, classification, approval, rounding, FX, dimension, source, master-data, and authority selectors. Every mutation that can change one of those resolved inputs acquires the same applicable lock and increments its selector/version before commit. The locking protocol prevents phantom or overlapping configuration rows and authority/configuration drift: either the mutation wins and posting re-resolves the new version before any ledger write, or posting wins with the locked immutable versions; serializable/predicate-conflict losers retry resolution before mutation.

## 6. Posting transaction and recovery

### 6.1 Pre-transaction handoff

NestJS claims a company/draft/action-scoped idempotency handoff using the canonical request fingerprint and records the authenticated human authorization envelope. Existing pending/committed/audited lease and backoff semantics are reused. Payloads remain minimal and redacted.

### 6.2 Pending-approval transaction

When maker-checker applies, the initial post request runs one guarded tenant transaction that:

1. acquires the shared mutation-compatible selector/version locks for policy, period, entry classification, approval, rounding, FX, dimension, source, master-data, and authority selectors, then locks the request receipt key, draft, validation run, resolved rows and affected masters;
2. replays an existing matching request receipt or rejects a fingerprint conflict;
3. verifies the human maker's `Post` authority and exact draft/validation versions, re-resolves every locked selector and posting invariant, recomputes the maker-visible preview and canonical digest, and requires the bound preview to remain current before creating the frozen candidate;
4. locks the draft-version/candidate-fingerprint approval uniqueness key and rejects any competing non-stale chain;
5. creates exactly one immutable `pending` approval containing the frozen candidate, with no native move, move line, source link or balance mutation;
6. writes one authoritative tenant `posting.approval_requested` audit event and immutable request receipt in the same transaction; and
7. commits the approval, event and receipt together.

Any exception rolls back all seven steps. Simultaneous same-key requests replay one approval/receipt/event; different keys for the same candidate produce one approval and one deterministic conflict. A platform-mirror failure withholds success and recovery mirrors the committed request without creating another approval. The `202` response is returned only after the request handoff is audited.

### 6.3 Immediate-post or approval-post transaction

When maker-checker does not apply, the authorized post request enters this transaction directly. When it applies, only the approval command enters it, using its own action-scoped idempotency key and authenticated checker authorization. In one guarded tenant transaction it:

1. acquires the shared mutation-compatible selector/version locks for policy, period, entry classification, approval, rounding, FX, dimension, source, master-data, and authority selectors, then locks the posting receipt key, draft, pending approval if any, validation run, resolved rows and affected masters;
2. replays an existing matching posting receipt or rejects a fingerprint conflict;
3. for immediate posting, verifies the requesting human’s `Post` authority; for approval posting, revalidates the recorded maker’s `Post` authority/scope, verifies the distinct checker’s `Approve` authority/scope, and atomically claims the still-pending approval;
4. verifies exact draft/validation/candidate versions and, for immediate posting, binds the supplied digest to the server-rendered immediate-post preview and confirmation, then recomputes canonical totals, preview digest and snapshots;
5. re-evaluates company, active posting accounts/journal/currencies, dimensions, source, FX provenance, rounding treatment and applicable matrix/period/approval result, marking a changed approval candidate stale without ledger movement;
6. locks the draft terminal-post uniqueness key so simultaneous immediate/approval commands have one winner;
7. creates the native move and lines in draft state internally, applies KEMFAI/source/policy/dimension metadata, and invokes the single guarded native posting transition;
8. verifies the resulting move is posted, balanced in company base currency, linked exactly once, and contains no transformed or omitted accepted value;
9. transitions the claimed approval to `approved` when applicable and writes the authoritative tenant posting audit event and immutable posting receipt; and
10. commits move, lines, source links, approval transition, event and receipt together.

Any exception rolls back all ten steps. No caller can invoke the internal native transition directly. Simultaneous approval commands or immediate-post keys produce one posted entry/receipt/event and deterministic replay or conflict; no losing command can leave an approval transition or ledger row.

### 6.4 Mirror and response

NestJS marks Odoo committed, appends/deduplicates the platform audit mirror, marks the handoff audited, then responds. Mirror failure withholds success. Recovery uses the original operation UUID and human authorization envelope, verifies the tenant receipt, and completes the mirror exactly once. It never re-authorizes or creates a second move.

## 7. Rounding and FX boundary

The v1.0 matrix permits configured rounding only within currency minor-unit tolerance and requires a configured rounding account. Therefore posting:

- never silently truncates or transforms a draft amount;
- blocks excess-scale or imbalance unless an applicable company/currency rounding configuration is present;
- if applicable, creates one transparent rounding line whose exact amount, account, rule version, actor, and original totals are retained and previewed before human confirmation;
- blocks any difference above tolerance; and
- retains transaction amount, base amount, rate, source, effective date, precision, and metadata versions immutably.

Rate lookup, realized FX and revaluation are outside this addendum. Posting consumes caller-supplied draft amounts/provenance and the configured approved source; it does not infer a missing rate or base amount. Each foreign-currency line snapshots `rateSourceKind` as `configured_provider` or `manual_override`. Provider provenance must match the effective company source configuration. Manual override requires the authenticated actor's specific server-side `Override FX Rate` permission and a nonblank recorded reason; the line retains the actor, reason, rate/reference, effective date, source configuration/version, and audit link. Missing or unauthorized override evidence blocks atomically.

## 8. UI and accessibility contract

The existing draft composer gains a posting-impact review only when capability is enabled. It shows exact lines, base/transaction totals, dimensions, source, period result, matrix v1.0, rounding line if any, approval requirement, and explicit irreversible-posting language. The user must actively confirm; no preselected or AI-triggered confirmation exists.

EN/LTR and AR/RTL flows require keyboard-complete grid/review/dialog operation, visible focus, semantic headings/tables, error summary linked to line fields, announced pending/success/failure status, duplicate-submit prevention, 200% zoom, and localized empty/loading/recoverable-error states. Input is preserved on failure. The approval inbox uses the scope-filtered pending-approval collection, then the authorized non-mutating approval-detail read operation to expose the exact evidence and clearly identify maker/checker separation. Checker-visible totals and rounding are preview computations only. The UI must submit the returned canonical `previewDigest` with the checker’s explicit `APPROVE` confirmation and exact strong approval ETag. After explicit checker confirmation, the approval command performs the final recomputation under the guarded transaction locks; it posts only if the final evidence exactly matches the checker-confirmed preview and its digest, otherwise it marks the candidate stale with zero ledger effect and requires a new review.

## 9. Test-first implementation gate

A future generated task graph must place all tests before first posting implementation and include, at minimum:

- contract tests for exact routes, schemas, auth, headers, ETags, status/error codes, route absence while disabled, and no native leakage;
- Odoo tests for balance, atomic rollback, immutable posted state, scope, exact values, source/dimension/policy snapshots, rounding limits, native transition guard, and receipt/audit failure;
- true two-connection races for same key, same draft with different keys, approval decisions, immediate-post preview-input drift, and approval/policy/entry-classification/period/rounding/FX/dimension/source/master-data/authority selector changes, including phantom/overlapping rows;
- Nest integration tests for real RPC, handoff leases, lost responses, mirror outage/recovery, opaque cross-tenant/company denial, and exactly-once results;
- frontend unit/accessibility tests in EN/AR/RTL and a no-interception browser journey; and
- fail-closed evidence validator tests written and observed red before fixture/evidence implementation.

No posting implementation may be merged while the required branch-protection check is absent or non-green.

## 10. Owned-live acceptance corpus

Final acceptance runs against exact-owned control DB, Redis, Keycloak, production Nest/Next, real Odoo, and at least two routed tenant databases on dynamic loopback ports. It must prove through the browser production path:

1. Create-only users cannot post and ledger hashes remain unchanged.
2. A balanced authorized Open-period draft posts once with exact lines, dimensions, currencies, source, matrix v1.0 and audit links.
3. Same-key simultaneous and lost-response retries return one entry/receipt/tenant-mutation event, each replay has one deduplicated platform replay event, and changed payload conflicts with an audited denial.
4. Two different simultaneous keys for one draft produce one winner and one deterministic terminal conflict.
5. Unbalanced, parent/inactive/cross-company inputs, missing dimensions, invalid FX/rounding, unauthorized or reasonless manual FX override, unavailable policy, unknown/overlapping entry classification, Soft Close without adjustment authority/reason, Finance Review without the mapped approved maker-checker workflow, and Hard Close all create no ledger rows.
6. Maker-checker creates no ledger movement before a different authorized checker approves; self-approval and duplicate decisions fail.
7. Tenant-audit failure rolls back the move; platform-mirror failure withholds success and recovery completes one mirror without another move.
8. User B obtains a real foreign UUID and User A receives opaque denial through ordinary auth with no foreign mutation; the authoritative opaque denial event and its platform persistence are verified.
9. Posted entry→source and source→entry traversal returns the exact authorized records.
10. EN and AR/RTL keyboard journeys pass, including recoverable error and duplicate-submit prevention.

Persisted evidence includes before/after move/line/balance hashes for both tenant DBs; exact row counts/UUIDs/amounts/snapshots; permission, policy, period, approval, race, failure-injection, audit and source facts; route/capability probes; timing; secret scan; ownership registry; cleanup receipts; and zero survivors. The independent validator reads persisted state and rejects response-only, screenshot-only, skipped, intercepted, mocked, retried, flaky, partial, transformed, or survivor-tolerant evidence.

## 11. Release and rollback

`module.accounting_posting` is company/tenant entitlement data, default false, and cannot be enabled merely by addon installation or matrix approval. Capability is true only when the exact contract/addon/schema versions are ready, applicable matrix and period evaluators are healthy, required check is enforced and green, and release approval is recorded. Disabled means posting and approval mutation routes are unmounted and capability is false.

Rollback disables new posting requests; it never deletes or rewrites posted history. In-flight authorized operations are reconciled from immutable receipts before shutdown. Schema down-migrations that would discard posted, approval, policy, source, receipt, or audit history are prohibited.

## 12. Explicit exclusions

This addendum does not specify reversal/correction commands, opening-balance workflows, period transition/reopen commands, tax calculation, inventory costing, revenue schedules, automated FX realization/revaluation, recurring entries, or autonomous posting. Those require their own accepted specifications.

## 13. Independent review checklist

The reviewer must confirm:

- every approved matrix v1.0 posting/FX/rounding/period/maker-checker constraint is represented without adding policy;
- atomic balance, immutable history, human authorization, tenant/company isolation, exact policy version, execution-time period evaluation, idempotency/races, audit/source linkage, release gating, real-path evidence, and cleanup are deterministic;
- Stories 5–7 are not accidentally implemented or accepted;
- no current production route, model, task, flag, or acceptance status is enabled by this document; and
- T152 remains the completed historical review record for v1.0; all v1.1 ambiguities and review findings are resolved before this amendment is commissioned for Story 4 runtime implementation.
