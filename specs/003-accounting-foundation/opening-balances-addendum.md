# Story 6 Addendum — Controlled Opening Balances

**Feature:** `003-accounting-foundation`
**Addendum version:** 1.0
**Status:** INDEPENDENTLY REVIEWED — specification accepted; no implementation or production activation authorized
**Policy authority:** `accounting-policy-matrix.md` v1.0, approved 2026-11-07
**Prerequisites:** `posting-addendum.md` v1.0 and `reversal-addendum.md` v1.0, independently reviewed
**Scope:** User Story 6 only: Prepare → Validate → Preview/control totals → Approve where configured → Post for one company's opening ledger balances
**Independent review:** Codex — ACCEPT; verified against T156, matrix v1.0, Story 6, posting/reversal addenda, prior review blockers, and repository guardrails

## 1. Purpose and gate

This addendum specifies the future contract, domain model, atomic boundary, correction rules, and owned-live proof required by T156. It creates no runtime route, model, migration, task graph, feature enablement, or acceptance claim. Executable work may be commissioned only after independent review accepts this document and a new tests-first task graph is generated.

Story 6 is an opening-ledger foundation, not a full historical or subledger migration engine. Each batch represents one company, one cutoff date, one base currency, and one controlled source/evidence package. It posts exactly one explicitly identified opening entry through the authorized Story 4 posting boundary. Story 7 period transition and reopening commands remain separately gated.

## 2. Normative invariants

1. An opening batch belongs to exactly one authenticated tenant/company and has one cutoff date and base-currency snapshot for each version. The cutoff date is the accounting date of the resulting opening entry; there is no separate client-selectable posting date. Period selection and FX effective-date validation therefore use that cutoff date.
2. The batch retains a mandatory canonical source/evidence reference and digest, import or manual method, mapping version, control-total provenance, and line-provenance references. Evidence mode references an owned evidence object. Manual mode uses a server-managed source family and one immutable manual-source version record per canonical batch version. Each record has its own UUID and canonical digest covering the entered source description, expected control totals, line source tokens, actor, source-family UUID, source version, and creation timestamp; prior records are retained. Raw-file storage, malware handling, and retention are governed separately and are not defined here.
3. Editable preparation has zero ledger effect. Validation and preview are immutable results for one exact batch version and never move the ledger.
4. Every line uses an active posting account, exact transaction/base amounts, rate/source/effective-date provenance when applicable, and valid company-scoped dimensions. Parent, inactive, or cross-scope references block without disclosure.
5. Base-currency debit equals credit exactly. At least two nonzero lines are required. No client or server silently inserts a suspense, retained-earnings, rounding, or balancing amount.
6. Control totals are computed from the canonical batch version and reconciled to authorized source/evidence totals. Any unresolved difference blocks posting.
7. Approval where configured applies to the frozen preview. Any batch, line, master, mapping, source, policy, period, FX/rounding, or approval-selector change invalidates it before ledger mutation.
8. Posting is an explicit action by an authenticated human with `Post`. `Create`/`Edit` cannot post; `Approve` can check when configured but does not imply `Post`; `Reverse` is required for post-posting correction. AI and service identities cannot originate authorization.
9. A successful post creates exactly one native posted move classified `opening`, with one immutable batch/source link. It cannot use the ordinary draft route or be reclassified afterward.
10. One operation commits the opening move, lines, terminal batch state, source links, policy/period/approval snapshots, tenant audit event, and receipt together or commits none.
11. Exact replay returns the prior result. Changed-fingerprint reuse conflicts. Concurrent distinct keys for one batch produce one winner and deterministic audited losers.
12. Posted batches and entries are immutable. Correction requires a full linked reversal and a new opening correction batch; no overwrite, partial delete, netting, or in-place repost is allowed.
13. A separate opening capability and shared `module.accounting_posting` capability remain false/absent until implementation, independent acceptance, branch protection, and release approval pass. Disabled means route absence, not UI hiding.

## 3. Boundary and future contract

Every call follows browser → Next.js BFF → NestJS → guarded Odoo ORM → the authenticated tenant's exact database. Public payloads use KEMFAI UUIDs only; native model names, integer IDs, database names, RPC details, and URLs never cross the boundary.

A future additive contract may expose only:

| Method and path | Purpose | Success |
|---|---|---|
| `POST /v1/accounting/opening-batches` | Create an empty manual batch or one from a previously uploaded owned evidence object. | `201` |
| `GET /v1/accounting/opening-batches/{batchId}` | Read an authorized batch, lines, results, and lineage. | `200` |
| `PUT /v1/accounting/opening-batches/{batchId}` | Replace the exact editable batch version's header, lines, and mappings. | `200` |
| `POST /v1/accounting/opening-batches/{batchId}/validate` | Produce immutable validation for the exact version. | `201`; `200` replay |
| `POST /v1/accounting/opening-batches/{batchId}/preview` | Freeze reconciled control totals and snapshots. | `201`; `200` replay |
| `POST /v1/accounting/opening-batches/{batchId}/post` | Post the exact preview or create/replay required approval. | `201` posted; `202` approval required; `200` replay |
| `POST /v1/accounting/opening-approvals/{approvalId}/approve` | A distinct checker approves and atomically posts the frozen candidate. | `201`; `200` replay |
| `POST /v1/accounting/opening-batches/{batchId}/correct` | Atomically execute the Story 5 reversal-only primitive and create one linked fresh opening correction batch, or create/replay required reversal approval. | `201` reversal plus correction batch; `202` reversal approval required; `200` replay |

There is no generic import action, native endpoint, batch delete, posted-batch update, partial post, suspense command, or period transition/reopen command.

### 3.1 Preconditions

Mutations require authenticated user context, `X-KEMFAI-Company-Id`, `Idempotency-Key`, exact strong `If-Match` for the batch, preview, or approval, and correlation context. Wildcards are rejected. The server derives tenant, actor, grants, and company scope.

### 3.2 Editable payload

The payload contains cutoff date, base-currency code, source mode `manual|evidence`, opaque owned evidence UUID for evidence mode or a nonblank manual-source description for manual mode, expected exact source totals with provenance labels, source-mapping version, and lines. Each line contains account, exact transaction/base amounts and currencies, FX provenance, dimensions, description, and a mandatory opaque source-row token unique within the canonical source. On manual creation, the server creates the source family and first immutable manual-source version and returns their KEMFAI UUIDs. Every update that changes a digest-covered field creates a new immutable manual-source version bound one-to-one to the new canonical batch version; unchanged updates may reuse only an exactly matching digest. Prior source versions remain immutable and linked. Clients cannot submit actors, status, policy/period/approval results, native IDs, calculated actual totals, source digests, or audit fields.

### 3.3 Validate and preview

Validation returns all issues in deterministic order, row/field paths, canonical control totals, and `ledgerEffect: none`. It never infers missing accounts, dimensions, currencies, rates, base amounts, or balancing values.

Preview requires current successful validation. Validation, preview, approval, posting, audit, replay fingerprints, race locks, and recovery all bind to the exact manual/evidence source version UUID and digest associated with that canonical batch version. Preview recomputes exact debit/credit and per-currency totals, verifies configured controls against authorized source totals, and freezes batch/version, validation, source version/digest/mapping, cutoff/base currency, lines, totals, matrix/period/FX/rounding/approval selector versions, and canonical hash. Each control is `reconciled|difference|not_applicable` with expected, actual, difference, evidence reference, and rule version. Any difference or unexpected `not_applicable` blocks preview.

### 3.4 Posting and approval

The post request contains only `batchVersion`, `previewId`, human `confirmation: POST OPENING`, and a reason when the effective period or approval rule requires it. The server resolves matrix, period, FX/rounding, and approval rules.

The Story 4 approval selector is reused with action kind `opening`. Exactly one effective configuration explicitly enables or disables maker-checker; missing, overlapping, unknown, or erroneous selection fails closed. Required approval freezes the preview and creates one candidate/event/receipt with zero ledger effect. A distinct authorized checker revalidates every mutable fact and atomically posts.

Immediate posting or approval execution reuses every Story 4 invariant: execution-time policy/period resolution, active masters, exact values, FX provenance, configured rounding treatment, human authority, guarded native posting, source linkage, audit, receipt, idempotency, and recovery. The entry additionally snapshots opening provenance classification, batch/preview UUIDs, cutoff/accounting date, controls, source/mapping, and line provenance. `opening` is provenance, not the period action class. A versioned company entry-classification mapping resolves transaction type key `opening_balance` to `routine|adjustment` under the Story 4 selector lock. No default class is implied: missing, overlapping, stale, or unknown mapping blocks. Open, Soft Close, Finance Review, and Hard Close then apply exactly the Story 4 matrix/configuration behavior to that resolved class.

## 4. Authorization

- `View` reads scoped batches and lineage.
- `Create`/`Edit` creates or replaces editable versions and runs validation/preview.
- `Post` is required for the final request.
- `Approve` plus effective action/amount scope is required for a checker; the maker needs `Post` and cannot check their own request.
- `Reverse` plus the exact `Correct Posted Entry` permission is required to correct a posted opening. `Post` alone cannot create a correction chain.

All grants are server-derived and company/action/amount scoped. Foreign resources are rejected without existence disclosure.

## 5. Domain model

### 5.1 Opening batch and line

A future company-scoped opening batch retains public UUID, status `preparing|validated|previewed|pending_approval|posted|superseded`, concurrency version, cutoff, base-currency metadata version, source mode/source-family UUID/exact source-version UUID/digest, mapping version, creator, expected/actual controls, reconciliation results, latest validation/preview, posted-entry, correction/reversal, approval, receipt, audit, operation and correlation references, and immutable lifecycle actors/timestamps.

Edits create a new canonical version and invalidate prior results without erasing them. Posted and superseded versions cannot be edited or deleted. Each line retains public UUID, batch/version, source-row token, posting account, exact amounts/currencies, FX provenance, dimensions, description, mapping result, and ordered issues.

### 5.2 Immutable results and links

Validation and preview records are immutable and keyed by exact batch version and canonical hash. A pending approval freezes one preview and cannot be reused for another version. The posted entry links to batch, preview, evidence and mapping; every posted line links to its opening line and source-row token. Entry → batch/evidence and batch/evidence → entry traversal is authorized, opaque, and audited.

### 5.3 Uniqueness

A database uniqueness key over company, cutoff, and canonical source identity prevents duplicate successful openings for the same controlled source. A separate batch terminal key permits one posted result. This does not impose a global one-opening-entry-per-company rule: distinct controlled source packages may require separate batches only when a future versioned company configuration explicitly permits it; absent or ambiguous configuration blocks.

## 6. Validation and control totals

Validation verifies one company/cutoff/base currency; account activity/kind/scope; currency enablement/precision; FX source/date/manual-override authority; dimensions; exact line/account/currency/base totals; source and mapping completeness; duplicate source rows; and absence of a prior successful opening for the same uniqueness identity.

The preview shows expected, actual, and difference for base debit/credit, each transaction currency, and each configured source category. Category controls are versioned configuration, not hard-coded account-name/code inference. Subledger controls may be retained as source reconciliation facts, but this workflow does not import subledger transactions.

Matrix v1.0 governs posting, FX, rounding, and period behavior. No missing rate, base amount, rounding line, retained earnings, or source category is inferred. Configured rounding, if applicable, follows Story 4 and is previewed before confirmation.

## 7. Correction and immutability

An editable batch may be revised; each revision supersedes prior validation/preview. A pending approval is frozen and an edit makes it stale before a fresh cycle.

A posted opening is never edited, deleted, or reposted in place. The correction request requires exact original/batch versions, `reversalDate`, optional configured `reversalJournalId`, mandatory nonblank `reason`, and human `confirmation: CORRECT OPENING`, plus `Reverse` and `Correct Posted Entry`. The reversal date/journal are evaluated exactly as Story 5 requires; the correction batch cutoff/accounting date is supplied in the request and independently validated under this addendum. Client-supplied reversal amounts, copied lines, policy/period state, or approval result are rejected.

The Story 6 adapter invokes Story 5's guarded **reversal-only** domain primitive, not Story 5's ordinary controlled-correction draft. When reversal approval is required, the initial request freezes both the reversal inputs and proposed opening-batch initialization, creates one pending reversal candidate/event/receipt with no reversal and no new batch, and returns `202`. Immediate execution or approval executes one tenant transaction: it performs the exact full Story 5 reversal, creates one fresh opening correction batch in the same source family with a new immutable source version whose digest covers the copied source/mapping context and new batch version, links original/reversal/new batch, writes one authoritative event and receipt, and commits all records together. Batch creation, linkage, receipt, or audit failure rolls back the reversal too. Recovery returns the immutable combined result and cannot create a batch after a separately committed reversal. Same-key races replay one combined result; distinct keys on the original chain have one winner.

The fresh batch remains unposted and requires new validation, preview, opening approval where configured, and Story 4 post. Its later posting failure never restores or deletes the already committed reversal. Later corrected openings form new separately authorized chains without weakening earlier uniqueness.

## 8. Atomic commands, races, and recovery

Create/update, validate, and preview each use scoped idempotency, immutable receipts, deterministic lock order, and one tenant transaction for result/audit/receipt. Post/approve adds entry-classification, selector, opening-uniqueness, terminal-batch, and ledger locks to Story 4's lock order. Correction additionally uses Story 5's original-chain and reversal locks and commits the reversal plus fresh opening batch in the single boundary defined in section 7.

Same-key races replay one result. Distinct-key races for one version or source identity produce one winner and deterministic conflicts. Concurrent edit/validate/preview/approval/post and source-version/mapping/master/policy/period changes serialize on source-family/version and batch locks or force re-resolution before ledger write.

Tenant-audit failure rolls back the domain mutation. Platform-mirror failure withholds success; recovery queries the immutable tenant receipt using the original human operation UUID and finishes mirroring without reauthorization, recalculation, or another result.

## 9. Audit contract

Every attempt records actor, tenant/company, action, batch/version/preview, cutoff, source/digest/mapping, controls, issues, policy/period/FX/rounding/approval snapshots, permission result, idempotency fingerprint, correlation, outcome, and timestamp.

Pre-domain opaque denials are authoritative control-plane events. Domain denials and successes are tenant events mirrored to the platform. Replays reference the original receipt/event and add one deduplicated platform replay event per correlation. Edits, validations, previews, approvals, posts, corrections, stale/conflict denials, and failures are all auditable.

## 10. UI and accessibility

The workspace presents Prepare → Validate → Preview → Approve where required → Post, with current status, next action, and ledger-effect labels. It shows cutoff, source/evidence, mapping, exact controls/differences, row issue navigation, policy/period/approval result, and explicit opening-entry confirmation.

Upload/parsing, long validation, and posting expose accessible progress without duplicate submission. Empty batch/file, loading, parse/validation error, stale conflict, pending approval, and mirror recovery states are localized and retain accepted input. EN/LTR and AR/RTL support keyboard table navigation, visible focus, linked error summaries, live status, and 200% zoom. AI may assist mapping or explain issues but cannot authorize, approve, or post.

## 11. Test-first implementation gate

A future task graph must place all tests before first Story 6 implementation and include:

- contract tests for routes, schemas, ETags/headers, stable errors, disabled-route absence, and no native leakage;
- Odoo tests for states, source/mapping/cutoff uniqueness, exact amounts/FX/dimensions, controls, approval, atomic posting, correction lineage, receipt/audit failure, and guarded native posting;
- true two-connection races for keys, edits/validation/preview/approval/post, source/mapping/master/policy/period changes, and corrections;
- Nest real-RPC integration for lost responses, lease recovery, mirror outage, opaque denial, and exactly-once outcomes;
- EN/AR/RTL frontend accessibility tests and no-interception browser journeys; and
- fail-closed evidence-validator tests observed red before fixture/evidence implementation.

No implementation may merge unless the required branch-protection check is externally enforced and green.

## 12. Owned-live acceptance corpus

Final acceptance uses exact-owned control PostgreSQL, Redis, Keycloak, production Nest/Next, real Odoo, and at least two routed tenant databases on dynamic loopback ports. Through the browser production path it proves:

1. Authorized manual and owned-evidence preparation, mapping, all-issue validation, and exact control preview have zero ledger effect.
2. Exactly one authorized opening post has balanced exact amounts, currencies, FX/precision provenance, dimensions, opening classification, cutoff, batch/source/audit/policy/period/line traceability, and no unrelated ledger change.
3. Imbalance, invalid master/dimension/FX/rounding, cross-scope, source/cutoff/control difference, stale preview, unauthorized actor, disallowed period, and audit failure have zero ledger effect.
4. Maker-checker has no ledger effect before a distinct checker approves; stale/self/duplicate approval cannot post.
5. Same-key and distinct-key simultaneous races, lost-response recovery, and at least 100 exact replays produce one result; changed payload conflicts.
6. Concurrent source/mapping/master/policy/period mutation either wins before re-resolution or loses after the immutable snapshot; no stale ledger write occurs.
7. Posted correction preserves the original, creates one exact full reversal and one linked fresh batch, and requires a new full cycle; failed correction posting leaves the reversal and unposted batch intact.
8. Opening entry ↔ batch/source/audit traversal is scoped and exact; a real foreign UUID is denied opaquely with zero foreign mutation.
9. EN/AR/RTL file/empty/progress/error/conflict/approval/post/correction journeys pass by keyboard at 200% zoom.
10. Both tenant DBs prove persisted exact state, secret redaction, ownership/cleanup receipts, and zero survivors.

Persisted evidence includes before/after move, line, balance, batch, source-link, approval, receipt and audit hashes/counts; exact UUIDs/amounts/snapshots; race synchronization; failure-injection checkpoints; route/capability probes; timing; ownership registry; secret scan; and cleanup receipts. The independent validator rejects response-only, screenshot-only, direct-model-only, mocked, intercepted, sequential-race, retried, skipped, flaky, transformed, partial, or survivor-tolerant evidence.

## 13. Release and rollback

Opening capability is company/tenant release data, defaults false, and depends on accepted Story 4 posting and Story 5 reversal contracts/addons/schemas plus this Story 6 contract/addon/schema. Matrix approval or addon installation alone cannot enable it. Disabled means all opening mutation routes are unmounted and capability is false.

Operational rollback disables new requests and reconciles already authorized operations from immutable receipts. It never deletes or edits posted opening history. Down migrations that could discard batch, source, mapping, preview, approval, posted entry, correction, receipt, or audit history are prohibited.

## 14. Explicit exclusions

This addendum does not specify full historical transaction migration, open AR/AP, inventory quantity/value, fixed assets, employee balances, bank reconciliation, migration template storage/retention/malware policy, period transition/reopen commands, tax calculation, automatic suspense posting, or autonomous AI actions. Subledger reconciliations may be retained as versioned source controls but no subledger transaction is imported or inferred here.

## 15. Independent review checklist

The reviewer must confirm:

- cutoff as accounting date, mandatory evidence/manual-source identity and digest, mapping, line validation, control totals, opening provenance versus configured period classification, and the atomic reversal-only correction adapter are deterministic;
- posting, FX, rounding, period, and approval behavior composes with matrix v1.0 and `posting-addendum.md` without inventing policy;
- posted immutability, linked reversal/correction, exact amounts/currencies/dimensions/source lineage, permissions, races, audit, real-path evidence, and cleanup are complete;
- Story 7 and out-of-scope migration workflows are neither implemented nor accepted;
- no runtime route, model, task, flag, acceptance status, or production capability is enabled by this document; and
- ambiguities are resolved before T156 is checked complete.
