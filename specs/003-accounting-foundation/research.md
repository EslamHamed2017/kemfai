# Research Decisions: KEMFAI Accounting Foundation

**Date:** 2026-10-29
**Scope:** Technical decisions for Stories 1–3 and safe boundaries for Stories 4–7.
**Policy status:** This research selected no Accounting Policy Matrix value. Finance Owner approval of matrix v1.0 was recorded later on 2026-11-07; the reviewed Story 4 addendum remains specification-only and does not authorize implementation or activation.

## Repository Findings

- The repository is already a Next.js 15 / NestJS 10 / Odoo 18 Community three-tier system. CI pins Node 22.22.0, PostgreSQL 16.x, Redis 7.x, and `odoo:18.0` (`.github/workflows/ci.yml`).
- Existing addons are isolated `kemfai_*` modules and use Odoo inheritance and test cases; no Odoo core fork exists.
- Tenant identity is server-resolved from verified JWT subject through `TenantContextResolver`; explicit client tenant identity is not trusted.
- `CompanyOdooContextService`/Odoo RPC patterns route through the tenant registry's database and company. Accounting must reuse this boundary rather than query tenant PostgreSQL from NestJS.
- Global idempotency claims are control-plane records and cannot alone make a cross-database mutation exactly once. The company-setup flow already solves the critical window with a pre-call handoff, an Odoo same-transaction mutation receipt, lease recovery, and audit dedupe.
- Existing `AuditEventInterceptor` fails the HTTP response when platform audit append fails, but its comment acknowledges the action may already have happened. Accounting therefore needs same-transaction tenant audit evidence for an authoritative mutation; control-plane audit remains the searchable platform mirror/denial trail.
- The frontend already has authenticated server BFF routes, locale persistence, Carbon components, EN/AR catalogs, RTL tests, and owned-live Playwright patterns.
- Existing owned fixtures demonstrate exact labels, dynamic loopback port reservation, real resource readiness, bounded waits, process-group ownership, secret redaction, evidence validation, and survivor checks. Fixed development Compose ports are unsuitable for final acceptance.
- At the 2026-10-29 research baseline, `accounting-policy-matrix.md` was pending and its recommendations were not authority. Matrix v1.0 was subsequently approved on 2026-11-07, and `posting-addendum.md` v1.0 was independently reviewed; neither event enables posting without a new tests-first executable task graph, implementation, acceptance, and release approval.

## Decision 1 — Odoo remains the tenant accounting system of record

**Decision:** Put COA, dimensions, journal/currency configuration, drafts, operation receipts, and authoritative accounting audit evidence in the exact tenant Odoo database. NestJS never directly queries tenant PostgreSQL.

**Rationale:** This preserves database-per-tenant isolation, uses the real production domain/ORM, and keeps a single future posted ledger in Odoo.

**Alternatives rejected:**
- Control-plane accounting tables: would put financial data in a shared database and bypass Odoo domain invariants.
- A new accounting microservice/database: adds a second system of record and an unjustified fourth tier.
- Browser-to-Odoo calls: violates the customer boundary and exposes native implementation details.

## Decision 2 — Extend native accounting masters; stage drafts in custom non-postable models

**Decision:**
- Extend native `account.account` and `account.journal` with KEMFAI UUID/version/localized and safety metadata.
- Reference native `res.currency` but use a company-specific `kemfai.account.currency.config` row only for enablement. Native code/decimal-place metadata is read-only and immutable through this API, carries its own metadata version, and is snapshotted separately from the enablement row; it is descriptive metadata, not owner-approved rounding policy.
- Store pre-policy drafts in `kemfai.account.draft` / `kemfai.account.draft.line`, not `account.move`.

**Rationale:** Native account/journal/currency foundations are explicitly reusable in the Blueprint. Company currency enablement must not be represented by toggling database-global `res.currency.active`. Custom drafts make “no posting before approval” structural: no native posting method or accidental automation can convert them.

**Alternatives rejected:**
- Custom copies of all native masters: duplicates mature Odoo foundations and weakens upgrade compatibility.
- Native `account.move` drafts now: technically possible, but exposes a native posting-capable object before policy, release, and audit controls exist.
- Store monetary values as floating point: risks binary rounding and silent precision loss.

## Decision 3 — KEMFAI UUIDs are the external identity boundary

**Decision:** Every customer-addressable tenant record has an immutable UUID (`kemfai_public_id`) unique in its tenant DB. OpenAPI and URLs use UUIDs only. Odoo integer IDs, model names, database names, RPC errors, and URLs stay internal.

**Rationale:** Stable non-sequential identifiers support opaque cross-scope denials and avoid leaking the underlying engine.

**Alternative rejected:** Odoo integer IDs in public routes, because they disclose implementation details and make enumeration easier.

## Decision 4 — Company context is a KEMFAI UUID, tenant context is server-derived

**Decision:** Auth derives tenant. `X-KEMFAI-Company-Id` carries a KEMFAI company UUID and is mandatory on accounting operations. The server resolves it inside the already-routed tenant DB and checks actor scope before any record lookup response.

**Rationale:** The current tenant model is one account→tenant, while the feature explicitly anticipates multiple companies. This avoids trusting tenant input and avoids exposing Odoo company IDs.

**Alternative rejected:** company in request bodies, because it is easy to apply inconsistently and complicates ownership enforcement.

## Decision 5 — Normalized dimension engine, not analytic-account overloading

**Decision:** Create `kemfai.dimension.definition`, `.value`, `.rule`, and `.assignment`. Seed the locked category keys `entity`, `branch`, `department`, `cost_center`, `project`, `salesperson`; permit custom definitions/tags as data. Rules target account and/or configured transaction-type key and are versioned.

**Rationale:** The spec requires multiple built-in and custom categories, scoped values, active history, and line-specific validation. A normalized engine preserves Account = What and Dimension = Where/Who/Why.

**Alternatives rejected:**
- Encode dimensions in account codes: directly violates P-04/FR-011.
- Use one flat tag field: cannot enforce category-specific requirements or scope.
- Treat Project only as an Odoo analytic account: does not satisfy the common typed/custom rule model and risks coupling this foundation to future project operations. A later adapter may link a dimension value to a project object without changing the accounting contract.

## Decision 6 — Parent/posting semantics are explicit and ORM-enforced

**Decision:** Add `kemfai_node_kind` and `kemfai_parent_id` to accounts. Parent nodes are selection-ineligible. Guarded methods lock rows, prevent cycles, validate company consistency, and reject destructive deletion. Historical references remain after deactivation.

**Rationale:** Native account classification alone does not express the required reporting hierarchy contract. Enforcement must hold for RPC/retry paths, not only the UI.

**Alternative rejected:** infer parent status from presence of children; that allows ambiguous empty parents and unsafe conversion races.

## Decision 7 — Exact decimal strings and explicit monetary metadata

**Decision:** Every transaction/base money tuple uses exact decimal strings and names all required metadata values: `transactionCurrencyCode`, `transactionPrecision`, `transactionCurrencyMetadataVersion`, `companyBaseCurrencyCode`, `basePrecision`, `baseCurrencyMetadataVersion`, and `currencyConfigurationVersion`. No JSON number or binary float is accepted or stored. Precision is a read-only snapshot of native currency decimal-place metadata, not a mutable configuration or rounding instruction. Draft save preserves the submitted decimal lexeme and scale byte-for-value, including scale beyond that metadata; it never rounds, truncates, calculates, or rejects an otherwise valid decimal because of excess scale. Validation surfaces `AMOUNT_SCALE_EXCEEDS_METADATA` as a policy blocker requiring future approved rounding treatment.

Foreign-currency lines (`transactionCurrencyCode != companyBaseCurrencyCode`) unconditionally require non-null caller-supplied `rateReference` and `rateEffectiveDate`; base-currency lines carry both fields explicitly as null. Missing foreign metadata produces stable `FX_RATE_REFERENCE_REQUIRED` and/or `FX_RATE_EFFECTIVE_DATE_REQUIRED` validation issues. These fields document provenance only: this slice does not select a provider/date rule, look up a rate, derive a rate, or calculate a base amount.

**Rationale:** The rounding and FX outcome policies are unresolved. Exact preservation and provenance completeness are policy-independent; calculation of missing base amounts, rejection/rounding to metadata scale, tolerance adjustments, or posting FX differences are not.

**Alternatives rejected:** JSON numbers/floats; implicit current exchange rate; auto-rounding; treating a preview as a posting decision.

## Decision 8 — Draft validation has a named policy-independent ceiling

**Decision:** Validation may check schema, permissions/scope, account node/activity, journal/currency activity, debit-vs-credit exclusivity, required transaction/base currency metadata, conditional FX provenance, dimension rules, exact configuration/native-metadata versions, and arithmetic base debit/credit equality. It returns all errors and policy blockers plus `ledgerEffect: none`, base totals with `companyBaseCurrencyCode` and `basePrecision`, and the complete configuration snapshot. Excess scale is a policy blocker, not a save rejection or transformed amount. Validation does not decide whether a period state permits action, choose FX rates, calculate base amounts, round differences, satisfy approval policy, or declare a draft postable.

A result is `valid_for_draft`, never `valid_for_post`. When a check depends on the matrix, the result contains a stable `POLICY_APPROVAL_REQUIRED` blocker.

**Rationale:** Stories 1–3 are genuinely acceptance-ready while Stories 4–7 remain gated.

**Alternative rejected:** a generic `valid=true` that callers might interpret as authorization to post.

## Decision 9 — Optimistic concurrency plus database locks

**Decision:** Every mutation requires `Idempotency-Key`; same scoped key/fingerprint replays the original operation/audit/correlation receipt and changed payload returns `409`. Mutable resources expose integer `version` and a strong ETag (`"<version>"`); updates require that exact value and stale versions return `412`. Odoo guarded methods lock the row and compare before mutation/version increment. Currency PUT is unambiguous: `If-Match: *` means create-only and fails `412` if the row exists; an exact strong ETag means update-only and fails `412` if absent/stale. Every successful mutation returns ETag where a versioned/current resource exists, plus operation/audit/correlation/replayed receipt; validation follows the same protocol and returns `422` for request/domain validation without ledger effect.

**Rationale:** This prevents silent lost updates and makes browser recovery deterministic.

**Alternatives rejected:** last-write-wins; frontend-only version checking; timestamps with insufficient ordering precision.

## Decision 10 — Durable mutation/audit protocol reuses the proven handoff pattern

**Decision:** Generalize the company mutation pattern for accounting:

1. NestJS commits an `accounting_mutation_handoff` intent/fingerprint before RPC.
2. Odoo guarded method locks/checks/mutates and writes `kemfai.account.mutation.receipt` plus append-only `kemfai.account.audit.event` in the same tenant transaction. Validation-run creation is a mutation under this rule even though its ledger effect is zero. Tenant receipt/audit write failure rolls the entire Odoo transaction back.
3. NestJS records Odoo-committed state, appends/dedupes the platform audit mirror, then marks handoff audited and only then responds. Mirror failure withholds success and leaves recoverable state; it never fabricates a failed tenant mutation or loses the authoritative tenant event.
4. Recovery workers lease incomplete handoffs and replay by operation UUID. Same UUID returns the stored result; changed fingerprint is conflict.
5. Denials before Odoo are appended to the existing platform audit with opaque identifiers.

**Rationale:** This closes duplicate/retry windows and ensures the exact tenant mutation always has authoritative audit evidence. The platform mirror can recover without inventing success.

**Alternatives rejected:** only the global interceptor; distributed transaction/2PC across control and tenant DBs; swallowing audit failure; holding a control DB transaction open across RPC.

## Decision 11 — Feature gating is split and fail closed

**Decision:** `module.accounting_foundation` gates safe masters/drafts. `module.accounting_posting` gates later policy-dependent operations and remains missing/false until policy approval plus implementation acceptance. v1 contains no posting operation at all.

**Rationale:** A UI-hidden post button is insufficient. Route absence and separate release state prevent partial workflows.

**Alternative rejected:** one accounting flag, because safe draft rollout could accidentally expose unfinished posting.

## Decision 12 — Versioned API contract is additive and posting-free

**Decision:** Publish OpenAPI 3.0.3 under `/v1/accounting`. Safe resources include capabilities, accounts, dimensions/rules, journals, company currency configurations, drafts, and draft validation. Posting-era operations require a future contract revision/addendum after owner approval.

**Rationale:** Explicit path versioning prevents a later policy-dependent behavior from silently changing safe clients.

**Alternative rejected:** include disabled post endpoints now; their existence creates an avoidable attack/activation surface and implies policy semantics not yet approved.

## Decision 13 — Final acceptance uses a new exact-owned production-path fixture

**Decision:** Implement `scripts/test_accounting_foundation_owned_live.sh` by composing existing T093/T109/T112 mechanics, not by reusing the fixed dev stack. It must build/start production Nest/Next, real Keycloak/session, real Odoo 18, exact control DB plus at least two exact-owned tenant DBs and routing/provisioning rows, Redis, and Playwright on dynamically reserved loopback ports. The owned customer identity fixture creates two independently authenticated users with separate Tenant-A/Tenant-B memberships, at least Company A1 and A2 in Tenant A and Company B1 in Tenant B. It installs the addons and proves readiness independently on both routes. The cross-tenant proof first fetches a real Tenant-B resource as User B, then attempts that exact UUID through User A’s ordinary authenticated production path and proves opaque denial/no leakage/no mutation. Evidence and cleanup enumerate both DBs, users, memberships, mappings, companies, and resources and assert zero survivors.

**Rationale:** This is the spec's FR-046–FR-050 acceptance boundary.

**Alternatives rejected:** Supertest-only, direct Odoo tests, route interception, manufactured auth headers, fixed host ports, shared dev database, container-running-as-readiness, exit-code-only evidence.

## Decision 14 — Story 4–7 design is deliberately deferred at policy seams

**Decision:** The data model reserves nullable references/state names needed for future compatibility but defines no policy values or allowed-action tables. No posting transformer, reversal command, opening-post command, period transition authorization, or policy matrix seed is part of Stories 1–3.

**Rationale:** Architecture can preserve future linkage without trespassing on owner decisions.

**Alternatives rejected:** implement “industry defaults,” copy Odoo defaults, or use the proposal column in the pending matrix. All would silently decide owner-reserved policy.
