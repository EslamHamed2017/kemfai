# Story 5 Addendum — Reversal and Controlled Correction

**Feature:** `003-accounting-foundation`
**Addendum version:** 1.0
**Status:** INDEPENDENTLY REVIEWED — specification accepted; no implementation or production activation authorized
**Policy authority:** `accounting-policy-matrix.md` v1.0, approved 2026-11-07
**Prerequisite:** `posting-addendum.md` v1.0, independently reviewed
**Scope:** User Story 5 only: reversal-only and reversal-plus-linked-correction-draft actions for an existing KEMFAI posted entry
**Independent review:** Codex — ACCEPT; verified against T154, matrix v1.0, Story 5, posting addendum, and repository guardrails

## 1. Purpose and gate

This addendum specifies the future contract, domain model, atomic transaction boundary, and owned-live proof required by T154. It creates no runtime route, model, migration, task graph, feature enablement, or acceptance claim. Executable work may be commissioned only after independent review accepts this document and a new tests-first task graph is generated.

The original posted entry is immutable. Story 5 never edits, deletes, cancels, or silently replaces posted history. A reversal-only action creates one linked equal-and-opposite posted entry. A controlled correction atomically creates that same full reversal and one linked non-posting correction draft; the human edits, validates, and posts that draft later through the separately authorized Story 4 posting flow. Opening-balance correction and period transition/reopen commands remain Stories 6 and 7 and are not specified here.

## 2. Normative invariants

1. The original entry and all previously posted entries remain byte-for-byte immutable through KEMFAI.
2. A reversal creates exactly one new native posted move whose lines are equal and opposite to the original in both transaction and company-base amounts.
3. Reversal lines copy the original currency codes, exact amounts, rate/source/effective-date provenance, precision and metadata versions, account references, dimensions, and source relationships. Only the authorized reversal date, allowed reversal journal, descriptions, operation metadata, and reversal links may differ.
4. A correction action atomically creates one full posted reversal and one linked non-posting correction draft initialized from the original entry. Posting that draft is a later, separate human action governed by every accepted Story 4 posting invariant; reversal success never implies that the draft was posted.
5. Reversal-only requires an authenticated human with `Reverse`. Starting controlled correction requires `Reverse` plus `Correct Posted Entry`; editing the linked draft requires the corresponding draft permission. Posting it later separately requires `Post`. Maker–Checker is evaluated independently for the reversal/correction-start action and for the later Story 4 post whenever the effective company configuration requires it.
6. A nonblank reason and active human confirmation are mandatory. AI, schedulers, recovery workers, and service identities cannot originate authorization. Recovery may only resume the exact recorded human operation.
7. The reversal accounting date is evaluated against the current company period and approved matrix at execution time. System time cannot substitute for the requested accounting date.
8. The reversal journal defaults to the original journal. A different journal is accepted only when an applicable versioned company configuration explicitly allows it; absence, ambiguity, inactivity, cross-company scope, or stale configuration blocks.
9. At most one completed reversal/correction-start action may consume the same original entry. An entry already reversed or itself a reversal cannot start another chain. A later posted corrected entry is a new posted entry and is not permanently exempt from future correction; any later action evaluates it as its own original under then-current policy while duplicate operations against the earlier original remain prohibited.
10. One operation commits its moves, lines, bidirectional links, policy/period/approval snapshots, tenant audit event, and immutable receipt together or commits none.
11. Exact idempotent replay returns the original result. Reusing a key with a changed fingerprint conflicts. Concurrent distinct keys against one original produce one winner and deterministic audited losers.
12. `module.accounting_posting` and a separate fail-closed reversal capability remain absent/false until complete implementation, independent acceptance, branch protection, and release approval pass. Disabled means route absence, not UI hiding.

## 3. Boundary and future contract

Every call follows browser → Next.js BFF → NestJS → guarded Odoo ORM → the authenticated tenant's exact database. Public payloads use KEMFAI UUIDs only. Odoo model names, integer IDs, database names, RPC details, and URLs never cross the boundary.

A future additive contract may expose only these Story 5 commands:

| Method and path | Purpose | Success |
|---|---|---|
| `POST /v1/accounting/posted-entries/{entryId}/reverse` | Reverse one eligible original in full. | `201` reversed; `202` approval required; `200` exact replay |
| `POST /v1/accounting/posted-entries/{entryId}/correct` | Atomically reverse the original and create one linked non-posting correction draft. | `201` reversal plus draft created; `202` approval required; `200` exact replay |
| `POST /v1/accounting/reversal-approvals/{approvalId}/approve` | A distinct authorized checker executes the frozen reversal or correction. | `201` completed; `200` exact replay |
| `GET /v1/accounting/posted-entries/{entryId}/timeline` | Read the authorized original/reversal/correction lineage and audit links. | `200` |

There is no generic native action endpoint, partial line reversal, arbitrary chain endpoint, posted-entry update/delete, or Story 6/7 command.

### 3.1 Command headers and preconditions

Mutations require authenticated user context, `X-KEMFAI-Company-Id`, `Idempotency-Key`, an exact strong `If-Match` for the original or approval candidate, and correlation context. Wildcards are rejected. The server derives tenant, actor, permission grants, and company scope.

### 3.2 Reversal-only request

The request contains:

- `originalVersion`: the exact immutable posted-entry representation version;
- `reversalDate`: accounting date selected by the human;
- `reversalJournalId`: optional KEMFAI journal UUID; omitted means the original journal;
- `reason`: mandatory nonblank text;
- `confirmation`: literal `REVERSE` entered or actively confirmed by the human.

Client-supplied period state, matrix version, approval result, calculated reversal amounts, copied dimensions, native IDs, or permission claims are rejected.

### 3.3 Controlled-correction request

The request contains the reversal-only fields plus `confirmation: CORRECT`. The server creates a new KEMFAI correction draft in the same transaction as the reversal and initializes its header, lines, currencies, dimensions, and source context from the original entry. The response returns the new draft UUID and strong ETag.

The created draft has ledger effect `none` and is not valid-for-post merely because it was copied. The human may then change accounts, amounts, currencies, dimensions, date, journal, description, or source details through ordinary guarded draft APIs. Every difference is validated and audited. A later post uses the Story 4 route, its own idempotency key and preconditions, and separate `Post` authorization. Neither draft editing nor later posting can alter the original or reversal.

### 3.4 Stable outcomes and errors

- `401/403`: unauthenticated or unauthorized; foreign-resource behavior is opaque.
- `404`: absent or out-of-scope public resource without existence disclosure.
- `409`: idempotency fingerprint conflict, prior chain, recursive/invalid chain target, stale validation, already terminal draft, competing operation, or immutable-state conflict.
- `412`: original, draft, configuration, or approval ETag mismatch.
- `422`: disallowed period/date, invalid or unauthorized journal override, missing reason, unavailable policy, inactive master, transformed reversal snapshot, invalid correction draft, maker-checker self-approval, or any Story 4 posting failure.
- `503`: authoritative ledger/audit completion cannot be proven; success is withheld and recovery remains retryable.

Every rejected action proves zero new move, line, balance, chain, or source-link rows. Stable KEMFAI codes and localized message parameters may identify safe fields but never native or foreign details.

## 4. Authorization and maker-checker

`Reverse`, `Correct Posted Entry`, `Post`, and `Approve` are separate server-side grants with company and configured amount scope. A reversal-only maker needs `Reverse`. A correction-start maker needs `Reverse` plus `Correct Posted Entry`; correction-draft editing remains separately authorized. The later post independently requires `Post`. A checker needs `Approve` plus the applicable action scope and cannot be the maker when Maker–Checker applies.

The posting addendum's versioned approval selector is reused with action kind `reversal` or `correction`; no threshold or criterion is hard-coded here. Exactly one effective configuration must explicitly resolve Maker–Checker true or false. Unknown keys, invalid parameters, overlapping applicability, missing selection, or evaluation errors fail closed.

If approval is required, the initial request freezes the original, requested date/journal, reason, requested action kind, matrix, period, configuration, authorization, and canonical fingerprint. It writes a pending approval, audit event, and receipt atomically with no ledger movement and no correction draft. Approval revalidates all mutable facts. Any changed policy, period, permission, master, selector, or original-chain state makes the candidate stale without financial effect. Approval of a correction-start action atomically creates the reversal and draft; later draft posting has its own independent approval evaluation.

## 5. Domain model

### 5.1 Reversal chain

A company-scoped immutable `kemfai.account.reversal.chain` concept retains:

- public UUID, action kind `reversal|correction`, and status `pending|reversed|corrected|stale`;
- original entry UUID and immutable fingerprint;
- reversal entry UUID when the action reaches `reversed`;
- corrected entry UUID only after the linked draft is separately posted and the chain reaches `corrected`;
- correction draft UUID/version when applicable;
- reason, reversal accounting date, journal UUID and configuration version;
- matrix, period, approval-configuration and selector versions with canonical snapshot hashes;
- maker/checker identities and authorization evidence;
- operation UUID, idempotency fingerprint, receipt UUID, audit UUID, correlation IDs, and timestamps.

A database uniqueness constraint permits at most one non-stale chain for an original and at most one reversal result ever for that original. Original, reversal, and any later corrected entry are distinct, same-company records. A reversal entry cannot be an original for another chain. A corrected entry is otherwise an ordinary posted entry and may become the original of a future independently authorized chain; that does not relax uniqueness for any earlier original.

### 5.2 Posted-entry links

Immutable source links add relationships `reversal_of`, `reversed_by`, `correction_for`, and `corrected_by`. The original retains its existing business-source links. The reversal copies those links with explicit relationship to the original and chain. The corrected entry retains the correction draft as canonical source and links to both original and reversal. Timeline reads traverse in both directions under ordinary scope authorization.

### 5.3 Reversal line mapping

For each original line there is exactly one reversal line with:

- a new immutable public UUID and a link to the original line;
- swapped debit/credit values using the exact original transaction and base lexemes;
- the same account, transaction/base currency metadata, rate source/reference/effective date, precision snapshots, dimension assignments, and source evidence; and
- the new reversal entry/date/journal plus chain, operation, receipt, and audit references.

No recalculation, current-rate lookup, current precision substitution, rounding, netting, aggregation, omission, or sign inference is permitted. If the exact original values cannot be represented losslessly, the operation blocks before mutation.

### 5.4 Correction draft and later corrected entry

The correction-start transaction creates a standard non-posting `JournalDraft` linked to the original, reversal, and chain. Its initial exact lines and snapshots are copied from the original as editable draft values, not as mutation of posted history. Saving and validation follow the existing draft contract and retain ledger effect `none`.

If the human later posts that draft, the resulting corrected entry uses the posting addendum's posted-entry model and atomic posting validations. In the same posting transaction it adds immutable `correction_for`/`corrected_by` links and advances the chain from `reversed` to `corrected`. Posting failure leaves the already authorized reversal unchanged and the draft safely unposted; it cannot produce a partial corrected entry. Differences from the original are exposed as auditable structured lineage.

## 6. Resolution and locking

The service resolves exactly one original, applicable approved matrix, period containing `reversalDate`, approval configuration, and journal rule in the authenticated tenant/company. It acquires the same policy, period, approval, and classification selector locks defined by Story 4, plus an original-entry chain lock.

Period behavior follows matrix v1.0: Open permits authorized reversal/correction; Soft Close permits only specifically authorized adjustments with reason; Finance Review additionally requires the approved Maker–Checker adjustment workflow; Hard Close blocks. Action classification and permission keys remain versioned company configuration. This addendum does not define period transition/reopen authority.

Journal selection follows matrix v1.0: original journal by default; an override requires one explicit effective configuration permitting the candidate journal/action. Zero or multiple applicable rules, stale selector state, inactive journals, or cross-company journals block.

## 7. Atomic commands and recovery

### 7.1 Pre-domain handoff

NestJS claims an action/company/original-scoped durable handoff using a canonical redacted fingerprint and recorded human authorization envelope. Existing pending → Odoo-committed → audited lease/backoff semantics are reused. No control-plane row is authoritative financial state.

### 7.2 Pending approval

When Maker–Checker applies, one guarded tenant transaction locks selectors, receipt key, original chain key, original entry, and resolved configuration rows. It verifies all invariants, creates exactly one pending candidate, tenant audit event, and receipt, then commits together. It creates no move, line, correction draft, balance, or completed source link.

Same-key races replay one candidate. Different-key races for the same canonical action yield one pending chain and deterministic audited conflicts. Platform-mirror failure withholds `202`; recovery mirrors the existing result without another candidate.

### 7.3 Reversal-only execution

An immediate authorized request or approved candidate executes one guarded tenant transaction:

1. acquire selector, receipt, original-chain, original-entry, and affected master locks in deterministic order;
2. replay a matching completed receipt or reject a changed fingerprint;
3. verify current human authorization, approval separation when required, exact original eligibility, and no prior completed chain;
4. re-resolve matrix, period, journal, configuration, and active/scope facts;
5. construct an exact one-to-one opposite line set from immutable original snapshots;
6. create one native move internally and invoke the single guarded posting transition;
7. verify posted status, exact equal-and-opposite transaction/base totals, copied dimensions/currency/source data, and bidirectional links;
8. complete the chain or approval and write one authoritative tenant audit event and immutable receipt; and
9. commit all records together.

Any exception rolls back all nine steps.

### 7.4 Controlled-correction start and separate posting

The correction-start command performs the reversal-only execution and, in that same tenant transaction:

1. creates one standard non-posting correction draft initialized from the original header, lines, currencies, dimensions, and source context;
2. links original, reversal, draft, and chain bidirectionally;
3. verifies the reversal is exactly opposite, the original is unchanged, and the draft has ledger effect `none`;
4. advances the chain to `reversed`, completes the approval when applicable, and writes one tenant audit event plus one immutable operation receipt; and
5. commits the reversal move/lines, draft, links, chain, approval transition, event, and receipt together.

Any exception rolls back the reversal and draft together. The response never claims a corrected entry exists.

The human edits and validates the correction draft through ordinary draft routes. Posting it later is a separate Story 4 operation with a new idempotency key, exact draft ETag/validation, `Post` permission, and independently resolved Maker–Checker requirement. That posting transaction creates only the corrected entry and atomically adds its chain links. Failure leaves the prior reversal and unposted draft intact, with no partial corrected entry.

### 7.5 Mirror, response, and recovery

After Odoo commit, NestJS records committed state, deduplicates the platform audit mirror, marks the handoff audited, and only then responds. Recovery queries the immutable operation receipt and chain using the original human operation UUID. It may finish mirroring or return the recorded result; it cannot recalculate, reauthorize, or create another move.

## 8. Audit contract

Every attempt records actor, tenant/company, action, safe submitted UUIDs, original version, requested date/journal, reason, correction draft/version when present, policy/period/configuration snapshots, permission outcome, approval evidence, before/after lineage, operation/idempotency hash, correlation, outcome, and timestamp.

Pre-domain opaque denials are authoritative control-plane events. Domain denials and successes are authoritative tenant events mirrored to the platform. Exact replays reference the original receipt/event and add one deduplicated platform replay event per replay correlation. Fingerprint conflicts, stale candidates, self-approval, prior-chain attempts, and period/journal denials are independently auditable.

## 9. UI and accessibility contract

The posted-entry timeline shows original, reversal, and corrected entry without presenting the original as edited. Reversal and correction flows show exact copied amounts/currencies/dimensions/source links, selected date/journal, period result, policy version, reason, approval requirement, and irreversible confirmation. The correction preview distinguishes the fixed reversal from editable corrected lines.

EN/LTR and AR/RTL flows are keyboard complete, preserve visible focus, announce pending/success/failure, link error summaries to fields, prevent duplicate submission, retain input on recoverable failure, and remain usable at 200% zoom. Empty/loading/error/timeline states are localized. No AI-triggered or preselected confirmation is permitted.

## 10. Test-first implementation gate

A future generated task graph must put all tests before first Story 5 implementation and include:

- contract tests for exact routes, headers, ETags, statuses, schemas, disabled-route absence, and no native leakage;
- Odoo tests for immutable original, exact one-to-one opposite lines, currencies, dimensions, sources, lossless values, journal/date rules, chain uniqueness, atomic reversal-plus-draft rollback, separate corrected-entry posting/linkage, receipt/audit failure, and guarded native posting;
- true two-connection races for same key, distinct keys on one original, approvals, original-versus-reversal activity, and concurrent policy/period/journal/approval configuration changes;
- Nest integration tests for real RPC, lost responses, lease recovery, platform-mirror outage, opaque tenant/company denial, and exactly-once outcomes;
- EN/AR/RTL frontend unit/accessibility tests and no-interception browser journeys; and
- fail-closed evidence-validator tests observed red before fixture/evidence implementation.

No Story 5 implementation may merge unless the required branch-protection check is externally enforced and green.

## 11. Owned-live acceptance corpus

Final acceptance uses exact-owned control PostgreSQL, Redis, Keycloak, production Nest/Next, real Odoo, and at least two routed tenant databases on dynamic loopback ports. Through the browser production path it proves:

1. Unauthorized, wrong-company, and foreign-tenant users cannot reverse/correct; User B supplies a real foreign UUID and User A receives opaque denial with zero foreign change.
2. One authorized Open-period reversal leaves the original unchanged and creates one exactly opposite linked entry with copied currencies, dimensions, rates, source evidence, policy and audit facts.
3. One authorized correction-start atomically creates the exact reversal and linked non-posting draft; injected failure at reversal, draft creation, linkage, receipt, or audit leaves neither the reversal nor draft. A later separately authorized Story 4 post creates the corrected entry and lineage; posting failure leaves the reversal and unposted draft intact with no partial corrected entry.
4. Original-journal default succeeds; inactive/cross-company/unconfigured override journals fail with zero ledger effect.
5. Soft Close, Finance Review, and Hard Close outcomes match the effective versioned matrix/configuration; clock changes do not alter accounting-date evaluation.
6. Maker–Checker produces no ledger movement before a different authorized checker acts; self-approval, stale approval, and duplicate approval fail.
7. Same-key simultaneous requests, lost-response recovery, and at least 100 exact replay requests produce one chain/result/tenant mutation event; changed-payload reuse conflicts and is audited.
8. Distinct simultaneous keys for one original produce one winner and one deterministic conflict. Attempts against an already reversed original or reversal entry cannot create recursive/duplicate chains. A corrected result may later be corrected only as a new original under a separate authorized chain; doing so cannot create another reversal for the earlier original.
9. Tenant-audit failure rolls back every financial row. Platform-mirror failure withholds success and recovery creates one mirror without another move.
10. Original → reversal/correction and reversal/correction → original timeline/source traversal returns exact authorized records.
11. Both tenant DBs prove persisted exact amounts and snapshots; the untouched tenant and denied company retain identical move/line/balance hashes.
12. EN and AR/RTL keyboard journeys pass at 200% zoom, including localized period/journal/approval/conflict failures and duplicate-submit prevention.

Persisted evidence includes before/after move, line, balance, chain, source-link, receipt, and audit hashes/counts for both DBs; exact UUIDs/amounts/snapshots; race synchronization facts; failure-injection checkpoints; route/capability probes; timing; ownership registry; secret scan; cleanup receipts; and zero survivors. The independent validator rejects response-only, screenshot-only, direct-model-only, mocked, intercepted, sequential-race, retried, skipped, flaky, transformed, partial, or survivor-tolerant evidence.

## 12. Release and rollback

Reversal/correction capability is company/tenant release data, defaults false, and depends on the exact accepted Story 4 posting contract/addon/schema plus this Story 5 contract/addon/schema. Matrix approval or addon installation alone cannot enable it. Disabled means all three mutation routes are unmounted and capability is false.

Operational rollback disables new requests and reconciles already authorized operations from immutable receipts. It never deletes, edits, nets, or automatically reverses posted history. Down migrations that could discard original/reversal/correction, approval, source, receipt, policy, period, or audit history are prohibited.

## 13. Explicit exclusions

This addendum does not define partial reversals, cancellation without a posted opposite, arbitrary reversal chains, opening-balance preparation/posting, period transition/reopen commands, tax corrections, FX realization/revaluation, inventory re-costing, revenue-recognition rewrites, recurring corrections, or autonomous AI actions. Story-specific correction workflows outside manual journal entries require their own reviewed adapters while preserving this contract.

## 14. Independent review checklist

The reviewer must confirm:

- matrix v1.0 reversal date, journal default/configuration, Maker–Checker, reason, permission, and duplicate-chain semantics are represented without inventing policy;
- original immutability, equal-and-opposite transaction/base values, currencies, dimensions, source lineage, period evaluation, atomic reversal-plus-draft creation, separately authorized corrected-entry posting, retry/races, audit, tenant isolation, release gating, and cleanup are deterministic;
- the addendum composes with `posting-addendum.md` without weakening Story 4 invariants;
- Stories 6–7 are neither implemented nor accepted;
- no runtime route/model/task/flag or positive acceptance status is enabled by this document; and
- ambiguities are resolved before T154 is checked complete.
