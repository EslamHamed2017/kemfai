# Implementation Plan: KEMFAI Slice 2 — Accounting Foundation

**Branch**: `feature/003-accounting-foundation` | **Date**: 2026-10-29 | **Spec**: [spec.md](./spec.md)
**Input**: `specs/003-accounting-foundation/spec.md`
**Policy status**: [`accounting-policy-matrix.md`](./accounting-policy-matrix.md) v1.0 was **APPROVED by the Finance Owner on 2026-11-07**; [`posting-addendum.md`](./posting-addendum.md) v1.0 is independently reviewed, [`reversal-addendum.md`](./reversal-addendum.md) v1.0 is independently reviewed, [`opening-balances-addendum.md`](./opening-balances-addendum.md) v1.0 is independently reviewed, and [`periods-addendum.md`](./periods-addendum.md) v1.0 is independently reviewed. T153 verification confirms that the approved reversal policy requires the reversal date must be in an allowed period, the default journal is the original journal unless configured otherwise, Maker–Checker applies when configured, and duplicate reversal/correction chains are prevented. T157 verification confirms the approved period action table: `Open`: authorized posting/reversal/correction is allowed; `Soft Close`: routine posting is blocked; `Finance Review`: only approved adjustment workflows using Maker–Checker may proceed; and `Hard Close`: posting, reversal and correction are blocked. Reopening requires separate permission, a mandatory reason and append-only audit history. Accounting-date period evaluation cannot be bypassed by changing system time. These records satisfy specification gates only. No reversal implementation or production activation is authorized. No opening-balance implementation or production activation is authorized. No period-control implementation or production activation is authorized; posting, reversal, opening posting, and period controls remain disabled until new tests-first executable task graphs, implementation, tests, independent acceptance, and release-control gates pass.

## Summary

Deliver Stories 1–3 first as three independently acceptable vertical slices: (1) compact parent/posting chart of accounts, (2) normalized dimensions and draft-only validation, and (3) journals, company currency configuration, and multi-currency draft capture/preview. Each slice traverses Next.js → authenticated NestJS API/BFF → production domain service → real Odoo 18 Community ORM in the exact tenant database → append-only audit evidence, with EN/LTR and AR/RTL UI and exact-owned live proof.

No public or internal posting, reversal, opening-posting, or period-enforcement command is designed into the v1 safe-foundation contract. Stories 4–7 are a separate, fail-closed tranche. Finance Owner approval of Accounting Policy Matrix v1.0 permits their separately reviewed specifications to proceed; it does not itself create executable tasks or enable production posting. A separately reviewed release flag and acceptance gate are still required.

## Technical Context

**Language/Version**: Node.js 22.22.0 (CI), TypeScript 5.6 API / 5.9 frontend, Python 3.11-compatible Odoo 18 addon code.
**Primary Dependencies**: NestJS 10.4, Next.js 15.5/React 19, Odoo 18 Community (`account` plus isolated `kemfai_*` addons), PostgreSQL 16, Keycloak, Redis/BullMQ, Carbon, `next-intl`, OpenAPI 3.0.3.
**Storage**: One control-plane PostgreSQL database for identity/routing/idempotency/platform audit; one dedicated PostgreSQL/Odoo database per tenant for all accounting masters, drafts, receipts, and tenant accounting audit evidence. No accounting rows in the shared control plane.
**Integration**: Existing NestJS Odoo RPC boundary; customer-visible identifiers are KEMFAI UUIDs, never Odoo database/model identifiers.
**Testing**: Jest/Supertest contract and integration tests, Odoo `SavepointCase`/`TransactionCase`, Playwright + axe in both locales/directions, and a new exact-owned live fixture based on existing T093/T109/T112 patterns.
**Target Platform**: Linux containers; evergreen responsive browsers.
**Project Type**: Next.js web application + NestJS API/BFF + Odoo domain engine.
**Performance Goals**: Meet SC-007 for a five-line draft (≤3 minutes active time); normal master-data lists and draft validation target p95 ≤300 ms API time excluding startup; live fixtures use bounded readiness rather than timing assumptions.
**Constraints**: No Odoo core changes/native customer UI; database-per-tenant; all mutations retry safe and all updates conditionally version checked; no ledger movement in Stories 1–3; no invented policy; exact decimal strings with explicit transaction/base currency and native-metadata precision snapshots; draft save never rounds, truncates, or rejects excess metadata scale; foreign-currency lines require caller-supplied rate reference/effective date but no selected rate source or calculation; audit evidence required; bilingual/RTL and accessibility from first slice.
**Scale/Scope**: Seven stories and 50 FRs overall; this execution tranche accepts only Stories 1–3. Initial design supports multiple companies inside a tenant DB while every request selects exactly one authorized company.

## Constitution Check — Pre-Research Gate

| Principle / gate | Design evidence | Status |
|---|---|---|
| I. P-01 simple/progressive | COA and journal screens are direct; dimensions and currency metadata are progressively disclosed. | PASS |
| I. P-02/P-03 connected/no dead numbers | Drafts retain journal, account, dimension, currency, rate-reference, source, and audit identifiers; no report/KPI is introduced. | PASS |
| I. P-04 account vs dimension | Operational attributes use normalized `kemfai.dimension.*` records, never account code/name expansion. | PASS |
| I. P-05 AI assistive only | No AI or posting operation is present in the safe contract. | PASS |
| I. P-06 auditability | No destructive delete endpoints; deactivation preserves references; tenant audit is append-only. | PASS |
| I. P-07 configuration | Dimension rules and currency enablement are rows; no plan/policy/localization value is hard-coded. | PASS |
| II. Odoo Community/no core edits | Extend native models only from new `kemfai_accounting` and `kemfai_dimensions` addons. | PASS |
| III. API/BFF boundary | Next.js uses its BFF routes; only NestJS calls Odoo RPC. Native Odoo payloads/URLs/names are not returned. | PASS |
| IV. DB per tenant | All accounting data resolves through the authenticated tenant registry to exactly one tenant DB. | PASS |
| V. EN/AR Day 1 | Localized names/messages, `dir`, keyboard, focus, zoom, and axe/RTL proof are acceptance requirements. | PASS |
| VI. Vertical slices | Stories 1–3 each include UI, BFF, domain, Odoo ORM, audit, tests, and owned-live evidence. Stories 4–7 are not partially exposed. | PASS |
| VII. deterministic financial data | Decimal strings, currencies/precision, optimistic versions, receipts, source links, and zero-ledger-effect draft validation are explicit. | PASS |
| Quality gates | Spec → Accounting/Data → Test → Security/Tenant → Acceptance is preserved. | PASS |

**Pre-research result: PASS.** No constitutional exception is requested.

## Delivery Strategy and Gates

### Release-state split

- `module.accounting_foundation`: config-driven flag for Stories 1–3. It may be enabled only after each included vertical slice passes its live acceptance.
- `module.accounting_posting`: new, separate fail-closed flag for Stories 4–7. It MUST remain absent or disabled until the applicable separately reviewed addendum, implementation, independent acceptance, and release approval are complete. It is not a plan-name check.
- The safe OpenAPI contract contains no `post`, `reverse`, opening-post, approval, or period-transition operation. Route absence is part of contract testing.
- Draft validation returns `ledgerEffect: none` and never calls Odoo `action_post` or creates a posted `account.move`.

### Vertical Slice A — Story 1: Compact COA

1. Extend `account.account` with immutable KEMFAI UUID, company ownership, localized display names, node kind (`parent|posting`), parent relation, optimistic version, and guarded service methods.
2. Enforce unique code/company, acyclic hierarchy, parent non-postability, no destructive delete, and active-selection rules inside Odoo ORM methods—not only DTO/UI validation.
3. Add NestJS account list/create/update/deactivate services and Next.js `/accounting/chart-of-accounts` UI/BFF routes.
4. Persist same-transaction tenant audit + operation receipt; mirror/denial audit through existing platform audit patterns.
5. Prove hierarchy, selection validation, stale conflict, retry, scope denial, audit failure, empty/loading/error, EN/AR/RTL, and persisted exact tenant DB state.

### Vertical Slice B — Story 2: Dimensions + draft-only validation

1. Add `kemfai_dimensions` models for definitions, values, assignments, and versioned rules; seed only the locked built-in category keys (not policy values).
2. Add dimension CRUD/rules UI with progressive disclosure and normalized links to accounts/transaction type.
3. Introduce the minimum custom draft/draft-line staging models needed to save a line and run policy-independent account/dimension/scope/activity checks. These models are intentionally not `account.move`; they cannot be posted accidentally.
4. Add `POST .../drafts/{id}/validate`, returning all line-level errors without ledger effects. Do not evaluate unresolved posting, FX outcome, rounding, reversal, or period-action policy.
5. Prove required Project/Cost Center behavior, inactive historical display, stale rule edits, no COA growth, no ledger rows, audit and exact production path.

### Vertical Slice C — Story 3: Journals, currencies, full drafts

1. Extend native `account.journal` through KEMFAI service methods and UUID/version fields; no native UI exposure.
2. Add company-specific currency enablement over native `res.currency`; expose native decimal-place metadata read-only with an immutable metadata version, do not make it owner-approved rounding policy, do not toggle database-global currency state, and do not permit base-currency mutation in this slice.
3. Complete draft header/lines with exact transaction/base decimal strings; `transactionCurrencyCode`, `transactionPrecision`, `transactionCurrencyMetadataVersion`, `companyBaseCurrencyCode`, `basePrecision`, `baseCurrencyMetadataVersion`, and `currencyConfigurationVersion`; configuration/native-metadata snapshots; dimensions; source context; and an unconditional non-null caller-supplied rate reference/effective date on every foreign-currency line (both explicitly null on base-currency lines). Draft save preserves scale beyond metadata precision exactly and validation emits a future-rounding-policy blocker rather than rejecting or changing it.
4. Add journal/currency screens and the draft composer/preview. Preview is arithmetic display only; it must state that it is not posting and must not select FX/rounding policy.
5. Prove active/inactive selection, immutable base/native currency metadata, cross-company rejection, exact over-scale amount retention with a stable policy blocker, missing foreign-rate metadata validation codes, exact configuration and native-metadata version revalidation, balanced/unbalanced preview, and no `account.move`/ledger movement.

### HARD GATE — Stories 4–7

Stories 4 (posting), 5 (reversal/correction), 6 (opening posting), and 7 (period enforcement/transitions) MUST NOT enter implementation or production acceptance until all are true:

1. Finance Owner has explicitly approved all seven matrix categories; evidence records version, approver, timestamp, scope, effective date, and accepted values.
2. `accounting-policy-matrix.md` has no pending rows; Finance Owner approval of v1.0 is recorded with version, approver, timestamp, scope, effective date, and values.
3. `posting-addendum.md` v1.0 is independently reviewed for atomic posting, exact applied matrix version, period evaluation, human authorization, idempotency, audit/source linkage, release gating, and cleanup.
4. `reversal-addendum.md` v1.0 is independently reviewed for immutable originals, equal-and-opposite linkage, retained currencies/dimensions/source relationships, period evaluation, retry/races, audit atomicity, release gating, and exact-owned cleanup.
5. `opening-balances-addendum.md` v1.0 is independently reviewed for Prepare → Validate → Preview/control totals → Approve where configured → Post, cutoff/source/control totals, correction, permissions, retry/races, audit atomicity, release gating, and exact-owned cleanup.
6. T157 verifies the approved four-state period action table and reopening semantics without enabling a period workflow.
7. `periods-addendum.md` v1.0 is independently reviewed for effective company time, exact matrix/configuration lookup, immutable history, separate transition/reopening authorization, mandatory reopening reasons, true concurrency, audit atomicity, release gating, and exact-owned cleanup.
8. New versioned contract operations are added in a later contract version; none is smuggled into v1 safe endpoints.
9. `module.accounting_posting` remains disabled until owned-live acceptance proves human authorization, tenant isolation, balanced immutable ledger, audit/source linkage, retry/concurrency, and cleanup.

Owner approval is necessary but not sufficient for enablement. This document does not approve or infer any policy value.

## Reuse Inventory and Exact Planned Locations

### Reuse without copying

| Existing file/pattern | Reuse |
|---|---|
| `backend/api/src/common/tenant-context/tenant-context.resolver.ts` | Resolve tenant from verified JWT; never trust a tenant header/body. |
| `backend/api/src/common/guards/tenant-scope.guard.ts` and `tenant-owned-resource.decorator.ts` | Fail-closed ownership and non-disclosing denials. Extend registry for accounting UUID resources. |
| `backend/api/src/common/guards/role.guard.ts`, `feature-flag.guard.ts` | Permissions and safe/posting release split. |
| `backend/api/src/common/interceptors/idempotency.interceptor.ts` | Authenticated request claim/fingerprint semantics; pair with Odoo receipt because interceptor alone cannot span databases. |
| `backend/api/src/modules/company-setup/company-mutation-handoff.service.ts` and recovery worker | Pattern for pre-call durable handoff, lease recovery, same-operation replay, and audited terminal state; generalize, do not couple accounting to company-setup tables. |
| `backend/addons/kemfai_company_setup/models/mutation_receipt.py` | Same-Odoo-transaction operation receipt pattern. |
| `backend/api/src/integrations/odoo-rpc/odoo-rpc.service.ts` and `company-odoo-context.service.ts` | Sole server-side Odoo RPC and exact DB/company routing. |
| `backend/api/src/modules/audit/audit.service.ts`, `backend/api/src/modules/audit/entities/audit-event.entity.ts`, and `backend/api/test/support/audit-source-linkage.ts` | Append-only platform audit/dedupe and linkage assertions. |
| `frontend/src/lib/auth/company-setup-bff.ts`, `frontend/src/app/api/companies/current/setup/route.ts` | Authenticated server BFF, locale-safe error translation, no browser-to-Odoo calls. |
| `frontend/src/app/(onboarding)/setup-wizard/setup-wizard-screen.tsx` and `frontend/src/app/(onboarding)/setup-wizard/setup-wizard-error.ts`, `src/locales/{en,ar}/common.json` | Accessible forms, stale state, localized status/error patterns. |
| `backend/api/test/support/t112-live-fixture.ts`, `scripts/test_t093_owned_fixture.sh`, `scripts/test_t109_odoo_exposure.sh`, `scripts/test_t112_owned_fixture.sh` | Exact ownership, dynamic loopback ports, process groups, actual readiness, evidence, redaction, cleanup receipts, survivor checks. |
| `scripts/ci/test_odoo_addons.sh` and `.github/workflows/ci.yml` accounting job | Real Odoo 18 addon discovery/install/tests. |

### Likely new implementation files (future; not created by this plan)

```text
backend/addons/
├── kemfai_accounting/
│   ├── __init__.py
│   ├── __manifest__.py                 # depends: account, kemfai_tenant_core, kemfai_dimensions
│   ├── models/{account,journal,currency_config,draft,audit_event,mutation_receipt}.py
│   ├── services/{coa,journal_currency,draft_validation}.py
│   ├── security/ir.model.access.csv
│   └── tests/{test_coa,test_journals_currencies,test_drafts,test_audit_receipts}.py
└── kemfai_dimensions/
    ├── __init__.py
    ├── __manifest__.py                 # depends: account, kemfai_tenant_core
    ├── data/dimension_definition_data.xml
    ├── models/{definition,value,rule,assignment}.py
    ├── security/ir.model.access.csv
    └── tests/{test_dimensions,test_rules}.py

backend/api/src/
├── database/migrations/*-SeedAccountingFoundationFlags.ts
├── modules/accounting/
│   ├── accounting.module.ts
│   ├── accounting-odoo-context.service.ts
│   ├── accounting-mutation-{handoff,recovery}.service.ts
│   ├── entities/accounting-mutation-handoff.entity.ts
│   ├── accounts/{accounts.controller,accounts.service}.ts
│   ├── dimensions/{dimensions.controller,dimensions.service}.ts
│   ├── journals-currencies/{journals-currencies.controller,journals-currencies.service}.ts
│   ├── drafts/{drafts.controller,drafts.service,draft-validation.service}.ts
│   └── dto/*.ts
└── openapi/                            # extend central registration/contract checks
backend/api/test/
├── contract/accounting-foundation.contract-spec.ts
└── integration/{accounting-tenant-isolation,accounting-audit-failure,accounting-live}.integration-spec.ts

frontend/src/
├── app/(workspace)/accounting/
│   ├── chart-of-accounts/{page,chart-of-accounts-screen}.tsx
│   ├── dimensions/{page,dimensions-screen}.tsx
│   ├── journals-currencies/{page,journals-currencies-screen}.tsx
│   └── drafts/{page,draft-composer}.tsx
├── app/api/accounting/v1/**/route.ts
├── lib/auth/accounting-bff.ts
└── locales/{en,ar}/common.json         # extend existing catalogs
frontend/tests/
├── unit/accounting-*.spec.tsx
├── e2e/accounting-foundation.spec.ts
└── e2e-live/accounting-foundation.live.spec.ts

scripts/test_accounting_foundation_owned_live.sh
scripts/fixtures/accounting_foundation_validate_evidence.py
```

**Structure decision**: keep the established three-tier repository. Odoo owns tenant accounting invariants/data; NestJS owns authentication, routing, authorization, release gates, and safe public representation; Next.js owns customer UX/BFF. No fourth service or direct tenant-DB access is introduced.

## Test and Acceptance Strategy

For each mutable Story 1–3 workflow, tests must include: authorized success; denied role; other tenant/company opaque denial; same-key replay with the original receipt and altered-payload `409`; required update precondition and stale `If-Match` `412`; response ETag; `422` validation; fail-closed tenant audit/receipt failure; platform-mirror recovery before success; inactive/deactivated reference; EN/AR; keyboard/200% zoom; loading/error/empty; persisted Odoo state. Currency upsert additionally requires `If-Match: *` for create and the current strong ETag for update. Validation is itself a receipt-bearing, retry-safe mutation. Draft tests additionally assert exact transaction/base amount and metadata round-trip (including over-scale values), conditional FX metadata, complete configuration snapshots, no posted `account.move`, no ledger balances changed, no posting method called, and no posting route in the OpenAPI/live router.

Layered proof:

1. Odoo model tests: constraints, locks, version increments, receipts/audit same transaction, decimal fidelity.
2. API unit/contract: DTOs, permissions, error envelope, OpenAPI parity, no forbidden routes.
3. Integration: real control PostgreSQL + Redis and real Odoo JSON-RPC against at least two independently routed dedicated tenant DBs, with independently authenticated subjects/memberships and real cross-tenant resources.
4. Browser: rendered Next production build with real session and API, no route interception.
5. Owned-live: exact path and state/audit queries plus cleanup receipt/zero survivors (see `quickstart.md`).

## Constitution Check — Post-Design Re-check

| Principle / gate | Phase 1 verification | Status |
|---|---|---|
| P-01–P-07 | Data model separates accounts/dimensions, preserves links/audit, and contracts expose only safe draft operations. | PASS |
| Odoo extension only | New models/fields live only in planned `kemfai_*` addons; native models are inherited, not patched. | PASS |
| API/BFF only | OpenAPI is KEMFAI-shaped; quickstart explicitly rejects direct-model acceptance and scans for Odoo exposure. | PASS |
| Database-per-tenant | Model placement and live proof require exact routed DB assertions and cross-tenant denial. | PASS |
| Bilingual/accessibility | Contracts localize codes client-side without changing stored values; live matrix includes EN/LTR and AR/RTL. | PASS |
| Vertical slices/feature gates | Each safe story is end-to-end; policy-dependent tranche has a hard gate and separate disabled flag. | PASS |
| Deterministic integrity | Exact decimals, optimistic versions, operation receipts, tenant audit, validation snapshots, and zero ledger effect are modeled. | PASS |
| Mandatory quality gates | Research, model, OpenAPI, and quickstart align to all 50 FRs while acceptance scope remains Stories 1–3. | PASS |

**Post-design result: PASS.** No complexity violation requires an exception. The custom draft staging model is a safety boundary, not an alternative ledger; only future approved posting may transform it into the one native posted ledger.

## Complexity Tracking

None. The two addons correspond to the Blueprint's explicit `kemfai_accounting` and `kemfai_dimensions` boundaries. The custom draft staging model prevents premature use of native posting and does not create a second posted ledger.
