# Implementation Plan: KEMFAI Slice 1 — SaaS Onboarding Shell

**Branch**: `001-saas-onboarding-shell` | **Date**: 2026-09-13 | **Spec**: [specs/001-saas-onboarding-shell/spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-saas-onboarding-shell/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Deliver the end-to-end SaaS onboarding shell: public plan selection → email signup/verification/MFA → automatic
database-per-tenant provisioning → bilingual (EN/AR, full RTL) company setup wizard → plan-entitled module
selection → manual bank-transfer billing (customer submission + Billing Admin review/decision) → onboarding
checklist → time-limited, audited customer-support access — with roles/scopes, tenant/company scoping, and
audit events on every step, and zero exposure of native Odoo UI.

Technical approach: a **control-plane / tenant-plane split**. A single KEMFAI-owned control-plane PostgreSQL
database holds identity/registry data that is inherently cross-tenant or pre-tenant (accounts before a tenant
exists, the tenant registry itself, plans/entitlements, subscriptions, payment submissions, support-access
grants, and the platform audit log) — every row that is tenant-scoped carries an immutable `tenant_id` and is
enforced tenant-scoped at the NestJS API/BFF layer, satisfying FR-001 without requiring physical per-tenant
storage for platform metadata. Each tenant additionally gets its own dedicated Odoo 18 Community PostgreSQL
database (`kemfai_tenant_<id>`), created and migrated automatically and idempotently on email verification,
which is the "no shared accounting database" boundary the Constitution and Spec §29 actually lock. The NestJS
API/BFF is the only customer- and staff-facing boundary; Next.js/React (Carbon-based, `next-intl`, full RTL)
is the only UI; Keycloak (self-hosted, two realms) is the identity/MFA provider; MinIO (bucket-per-tenant)
stores payment-proof evidence; all plan/entitlement/limit values (including the FR-030a trial window and
unpaid-workspace restriction) are rows in a `plan_feature_entitlement` / `entitlement_default` structure, never
code constants.

## Technical Context

**Language/Version**: TypeScript 5.x / Node.js 20 LTS (API/BFF and frontend); Python 3.11 (Odoo 18 Community
runtime for `kemfai_*` addons).

**Primary Dependencies**: NestJS 10 (OpenAPI/Swagger via `@nestjs/swagger`, `class-validator`/`class-transformer`)
for the API/BFF; Next.js 14 (App Router) + React 18 + `@carbon/react` (Carbon Design System, RTL-capable) +
`next-intl` for the frontend; Odoo 18 Community + isolated `kemfai_*` addons as the business engine, reached from
NestJS via Odoo's JSON-RPC/XML-RPC external API (no direct cross-service DB access); `keycloak-admin-client` /
Keycloak REST Admin API for identity, verification email, and MFA (TOTP) enrollment; `@aws-sdk/client-s3`
against MinIO for evidence storage; BullMQ + Redis for background/idempotent jobs (tenant provisioning,
verification email dispatch, notification delivery); OmniRoute HTTP client reserved for Ask-KEMFAI (not
exercised by any Slice 1 user story, but the entitlement flag for it must exist per FR-030).

**Storage**: PostgreSQL 16 — one control-plane database (`kemfai_control`) for accounts, tenant registry, plans/
entitlements, subscriptions, payment submissions, support-access grants, and platform audit events; one
dedicated Odoo/PostgreSQL database per tenant (`kemfai_tenant_<tenant_id>`) for company, module-selection cache,
and onboarding-checklist source records (customers, banks, products). MinIO with one bucket per tenant
(`kemfai-tenant-<tenant_id>`) for payment-proof documents, keyed to the pre-existing control-plane payment
submission until a tenant DB exists (bucket is created at tenant-registry-record creation time, ahead of Odoo DB
provisioning, since proof upload only ever happens after a tenant is registered).

**Testing**: Jest + Supertest for NestJS unit/contract/integration tests; Playwright + `@axe-core/playwright` for
frontend e2e, accessibility, and EN/AR-RTL visual/DOM assertions; Odoo `odoo.tests.common` (Python) for
`kemfai_*` addon tests; OpenAPI-schema contract tests (`contracts/openapi.yaml` as source of truth) run against
the live BFF in CI.

**Target Platform**: Linux containers (Docker Compose in dev, container-orchestration-ready for production, per
`infra/docker`); evergreen desktop and mobile-responsive browsers for the frontend.

**Project Type**: Web application — three-tier (Next.js frontend, NestJS API/BFF, Odoo business engine), plus a
control-plane database owned exclusively by the API/BFF.

**Performance Goals**: Meet spec Success Criteria directly — SC-001 (plan→verification email <2 min active
effort), SC-003 (tenant/company usable within 5 min of verification), SC-008 (Billing Admin decision <5 min
active review time), SC-009 (expired support-access inaccessible within 1 min). General BFF read endpoints
(plans, checklist, entitlements) target p95 < 300 ms excluding provisioning/report-heavy operations.

**Constraints**: Database-per-tenant isolation is non-negotiable (Constitution Principle IV); no native Odoo UI,
terminology, or endpoint may ever reach a customer (Principle III, FR-042); every onboarding screen must be
fully correct and mirrored in EN/LTR and AR/RTL (Principle V, FR-014, FR-024); all plan/entitlement/limit values
including the FR-030a trial window and auto-restriction flag must be config rows, never `if plan == X` code
(Principle I P-07, FR-030/FR-030a); tenant provisioning, payment-decision processing, and support-access
enforcement must be idempotent (Principle VII); every significant action must produce an immutable, queryable
audit event (Principle VI, FR-007–FR-009).

**Scale/Scope**: 8 user stories, ~9 customer-facing screen groups + 1 internal (Billing Admin) queue; control
plane must not architecturally preclude thousands of tenants even though initial launch volume is small
(tens–hundreds of tenants).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — see "Post-Design Re-check" below.*

| Principle | Check | Status |
|---|---|---|
| I. Product Non-Negotiables (P-07 in scope for this feature) | Plan/feature/limit/trial-window/auto-restriction values live in `plan_feature_entitlement`, `entitlement_default`, and plan-level settings rows (data-model.md); no code path branches on a plan name or id. | PASS |
| II. Odoo Community Foundation, No Core Modification | All tenant-side business objects (company setup fields, module-selection cache) are added via new, isolated `kemfai_*` addons using standard Odoo inheritance/views; no Odoo core file is touched; no Enterprise/QuickBooks code is reused. | PASS |
| III. Customer-Facing Boundary — API/BFF Only | Frontend never calls Odoo directly; NestJS is the sole caller of Odoo's JSON-RPC API and the sole issuer of customer/staff-facing responses; FR-042 enforced by never proxying raw Odoo payloads/URLs to the client. | PASS |
| IV. Database-Per-Tenant Isolation | Every tenant gets a dedicated Odoo/Postgres database, created idempotently on verification (FR-022/FR-023). The control-plane database is explicitly *not* an accounting database — it holds no ledgers, invoices, or posted entries; it is scoped, addressed, and access-controlled per `tenant_id` at the API/BFF layer. See Complexity Tracking for the explicit justification of this split. | PASS (justified) |
| V. Bilingual by Day 1 | `next-intl` + Carbon RTL from the first commit of every screen; FR-014/FR-024/SC-005 drive Phase 1 design and the test strategy (RTL snapshot + a11y tests are mandatory, not optional). | PASS |
| VI. Vertical Slices & Implementation Contract | Each of the 8 user stories is planned end-to-end (UI → BFF → domain → Odoo/control-plane → audit → tests) in data-model.md/contracts; permissions, tenant scope, audit events, empty/error/loading, and accessibility are specified per story (spec.md FR-001–FR-042). The clause requiring incomplete modules to sit behind feature flags is met by a dedicated, config-driven `FeatureFlag` table + `FeatureFlagGuard` (data-model.md; tasks.md T099/T100), read through the same `EntitlementsService` as FR-030a rather than any hard-coded conditional; every story less mature than the P1 MVP core (US4 module selection, US7 checklist, US8 support access) carries this gate as an explicit acceptance criterion on its main implementation task (T076/T082/T088), not left to be inferred. | PASS (this row previously asserted PASS without addressing the feature-flag clause at all; corrected during remediation — see `specs/001-saas-onboarding-shell/analysis.md`, finding C1) |
| VII. Deterministic Data & Financial Integrity | Provisioning, payment-decision, and support-access-enforcement flows are keyed and idempotent (data-model.md state machines); files are MinIO object references, never DB blobs; audit events are append-only. No posted accounting entries exist in this slice (out of scope), so debits=credits is N/A here. | PASS |
| Quality Gates (tenant isolation, authorization, idempotency, source linkage) | Directly covered by the Test Strategy section below and carried into tasks.md. | PASS |

No unjustified violations. One documented architectural clarification is recorded in Complexity Tracking.

### Post-Design Re-check (after Phase 1: data-model.md, contracts/, quickstart.md)

Re-evaluated against the completed data model and contracts:

- **Principle IV**: `data-model.md` confirms no accounting/ledger data lives in `kemfai_control`; every table
  there is registry/billing-relationship/audit metadata. Still PASS.
- **Principle I (P-07)**: `contracts/openapi.yaml`'s `EntitlementSet` schema and `PlanFeatureEntitlement`/
  `PlanSetting`/`EntitlementDefault` tables confirm no plan-name branching surface was introduced by the API
  shape. Still PASS.
- **Principle VI**: Each of the 8 user stories now has a concrete request/response contract and Test Strategy
  coverage (tenant isolation, authorization, idempotency, source linkage) — no story was designed without its
  audit/permission/state surface. The feature-flag/module-gating clause, previously unaddressed, is now
  concretely satisfied by T099 (`FeatureFlag` entity + `EntitlementsService` extension) and T100
  (`FeatureFlagGuard`), and referenced from US4/US7/US8's acceptance criteria (T076/T082/T088) and tested
  cross-cutting in T112. Still PASS, now on a verified design basis rather than an unaddressed assumption.
- **Principle VII**: `PaymentSubmission`'s DB-level unique partial index and the `Tenant`/`SupportAccessGrant`
  state machines make idempotency a data-layer guarantee, not just an application convention. Still PASS.

No new violations or complexity were introduced during Phase 1 design; Complexity Tracking is unchanged from
the pre-design gate.

## Project Structure

### Documentation (this feature)

```text
specs/001-saas-onboarding-shell/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── openapi.yaml
│   └── events.md
├── checklists/
│   └── requirements.md
└── tasks.md              # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
frontend/                              # Next.js 14 App Router, Carbon-based, EN/AR LTR/RTL
├── src/
│   ├── app/
│   │   ├── (public)/                  # plan list, pricing — no auth required
│   │   │   └── plans/
│   │   ├── (auth)/                    # signup, verify, MFA enrollment
│   │   │   ├── signup/
│   │   │   ├── verify/
│   │   │   └── mfa/
│   │   ├── (onboarding)/              # authenticated, tenant-scoped customer flows
│   │   │   ├── provisioning/          # "setting up your workspace" loading/poll screen
│   │   │   ├── setup-wizard/
│   │   │   ├── modules/
│   │   │   ├── billing/
│   │   │   ├── checklist/
│   │   │   └── support-access/
│   │   └── (internal)/                # staff-only route group (Billing Admin, Support, Super Admin)
│   │       └── billing-review/
│   ├── components/                    # KEMFAI Carbon-derived components (shared)
│   ├── lib/
│   │   ├── api-client/                # generated from contracts/openapi.yaml
│   │   ├── i18n/                      # next-intl config, EN/AR message catalogs
│   │   └── rtl/                       # dir-aware layout helpers
│   └── locales/
│       ├── en/
│       └── ar/
└── tests/
    ├── e2e/                           # Playwright, incl. EN/AR-RTL + a11y (axe)
    └── unit/

backend/
├── addons/                            # Odoo 18 Community, isolated kemfai_* modules only
│   ├── kemfai_tenant_core/            # per-tenant bootstrap: initial company, base data
│   ├── kemfai_company_setup/          # setup-wizard fields on res.company + wizard state
│   ├── kemfai_module_selection/       # per-tenant enabled-feature cache mirrored from entitlements
│   └── kemfai_onboarding_checklist/   # computed readiness views over partner/bank/product
└── api/                               # NestJS BFF — the only customer/staff-facing boundary
    ├── src/
    │   ├── modules/
    │   │   ├── plans/                 # FR-016/FR-017
    │   │   ├── accounts/              # signup, verification, MFA — FR-018..FR-021
    │   │   ├── tenants/               # provisioning orchestration — FR-022/FR-023
    │   │   ├── company-setup/         # FR-025..FR-028
    │   │   ├── module-selection/      # FR-029/FR-030
    │   │   ├── entitlements/          # plan→feature→limit reads, incl. FR-030a trial config
    │   │   ├── billing-customer/      # FR-031..FR-033
    │   │   ├── billing-admin/         # FR-034..FR-036 (internal role only)
    │   │   ├── checklist/             # FR-037/FR-038
    │   │   ├── support-access/        # FR-039..FR-041
    │   │   └── audit/                 # FR-007..FR-009, read APIs for internal auditors
    │   ├── common/
    │   │   ├── guards/                # role + tenant-scope guards, applied identically to every path
    │   │   ├── interceptors/          # audit-event emission, idempotency-key handling
    │   │   └── tenant-context/        # request-scoped tenant resolution, cross-tenant denial
    │   └── integrations/
    │       ├── keycloak/              # admin API: user create, verify-email action, MFA
    │       ├── odoo-rpc/              # JSON-RPC client, one connection profile per tenant db
    │       ├── minio/                 # bucket-per-tenant evidence storage
    │       └── provisioning/          # idempotent tenant-db create/migrate job (BullMQ)
    └── test/
        ├── contract/                  # OpenAPI-schema conformance
        ├── integration/               # tenant isolation, idempotency, authorization, source linkage
        └── unit/

infra/
├── docker/                            # existing dev compose (Odoo+Postgres) — extended with api, keycloak, minio, redis
├── keycloak/                          # realm exports: kemfai-customers, kemfai-internal
└── provisioning/                      # tenant DB creation/migration scripts invoked by backend/api
```

**Structure Decision**: Three-tier web application in the existing monorepo (`frontend/`, `backend/addons`,
`backend/api` new, `infra/`). The API/BFF is added under `backend/api` alongside the existing `backend/addons`
Odoo modules directory so that the single customer/staff-facing boundary (Constitution Principle III) and the
isolated Odoo extension layer (Principle II) are physically separated within `backend/` while sharing the
`backend/` root for deployment grouping. No `src/`+`tests/` single-project layout applies (Option 1 removed);
no mobile/API-only layout applies (Option 3 removed) — Option 2 (web application: frontend + backend) is used,
expanded with the Odoo business-engine tier that this product's architecture always requires.

## Test Strategy

Per Constitution Quality Gates, automated tests must cover — at minimum — tenant isolation, authorization,
idempotency, and source linkage. For this feature, each is concretely scoped as follows (full test cases are
enumerated at task level in tasks.md; this section fixes what "covered" means so tasks.md cannot narrow it):

### Tenant isolation
- **Contract-level**: For every BFF endpoint under `(onboarding)`/`(internal)`, an automated test authenticates
  as Tenant A and attempts to read/write a resource (company, module selection, payment submission, checklist,
  support-access grant, audit event) belonging to Tenant B by ID — asserts 403/404 and asserts a
  `tenant_access.denied_cross_tenant` audit event is written (FR-001, SC-004).
- **Data-level**: An integration test provisions two tenants end-to-end and asserts the two Odoo databases and
  two MinIO buckets are physically distinct (not just logically filtered) — directly exercises Constitution
  Principle IV, not merely the BFF's guard logic.
- **Target**: 100% of customer-facing surfaces in this feature have at least one cross-tenant-denial test
  (traces to SC-004).

### Authorization
- A role-matrix test suite runs every mutating endpoint against each of: unauthenticated, Workspace Owner
  (own tenant), Workspace Owner (foreign tenant), Billing Admin, Support (no active grant), Support (active
  grant), Support (expired/revoked grant) — asserting the exact allow/deny expected per the Roles & Scopes
  table in data-model.md. Includes FR-004's explicit case: no customer-domain credential can ever reach a
  Billing Admin action (enforced structurally by realm separation, but tested as a behavior, not just
  configuration).
- Every authorization test is run twice per endpoint: once via the documented UI-driven call shape, once via a
  raw HTTP replay bypassing any client-side gating — both must be denied identically (FR-006, Edge Cases).

### Idempotency
- **Tenant provisioning**: retry the same verified-account provisioning request N times concurrently and
  sequentially; assert exactly one Tenant row, one Odoo database, one initial Company, one MinIO bucket
  (FR-023, Acceptance Scenario 2.5).
- **Payment decisions**: submit two concurrent "approve" calls for the same submission; assert exactly one
  activation, one `billing.subscription.activated` audit event, and the second call receives the 409 documented
  in `openapi.yaml` (Acceptance Scenario 6.6).
- **Payment submission**: attempt to create a second PendingReview/MoreInfoRequested submission for the same
  tenant+billing period while one is unresolved; assert the DB unique partial index (data-model.md) rejects it,
  not just an application-layer check (defense in depth).
- **Support-access sweep**: run the expiry sweep job twice in the same tick window; assert a grant is not
  double-flipped or double-audited.
- **Trial-window sweep** (F2 remediation — see analysis.md): run the `trial.expiry_sweep` job twice in the same
  tick window; assert a tenant is not double-restricted or double-audited (mirrors the support-access sweep test
  exactly, T111). Separately assert `TrialWindowGuard` never restricts a tenant whose Subscription is `Active`,
  and never restricts under a plan with `autoRestrictUnpaid` resolved false (T101).

### Source linkage
- Every `AuditEvent` written during any test above is asserted to resolve `subject_type`/`subject_id` back to a
  real, currently-queryable record (or a still-inspectable historical PaymentSubmission via `status_history`) —
  no audit event may reference a subject that cannot be traced (Constitution Principle II/P-03 spirit, FR-009).
- The FR-009 field list for a billing activation decision is asserted verbatim (all named fields present and
  non-null where required) on every `billing.payment_submission.decided` and
  `billing.subscription.activated` event — this is the direct test for SC-007.

### Additional coverage carried from the spec (not optional)
- EN/AR RTL + accessibility: Playwright + axe run against every screen listed in FR-013, in both locales,
  asserting keyboard operability, semantic roles, and full RTL mirroring (FR-014, SC-005) — failing axe
  violations or LTR-only rendering in AR fails the build, not just a warning.
- Empty/error/loading states: each state enumerated in FR-010/FR-011/FR-012 has at least one test asserting it
  renders (not a blank/frozen screen) under the triggering condition.
- Checklist liveness: create then delete each underlying record (customer/bank/product) and assert the
  checklist item flips back to incomplete without any direct checklist mutation (FR-037, SC-010).
- Colour-independent status labels (FR-015; U1/F7 remediation — see analysis.md): for every status/warning/error
  indicator in scope (Pending Review, Approved, Rejected, Request More Information, expired/active support-
  access grant, provisioning Pending/Creating/Ready/Failed), a dedicated assertion (T110) confirms a text/label
  is present and independently legible without relying on any colour cue. This is explicitly distinct from and
  not implied by an axe pass — axe does not detect colour-only encoding of state.
- Feature-flag/module-gating (Constitution Principle VI; C1 remediation — see analysis.md): a cross-cutting test
  (T112) asserts `FeatureFlagGuard` denies access to a flagged-off module identically via the documented UI-call
  shape and a raw HTTP replay, and that no module's route/UI surface bypasses the guard.
- Odoo-exposure full-surface sweep (FR-042, SC-011; G1/F6 remediation — see analysis.md): T052 alone (US3 wizard)
  is not sufficient coverage for SC-011's "zero instances... across acceptance testing" claim. T109 extends the
  same assertion (no native Odoo terminology, URLs, or raw Odoo payloads in any response or DOM) across billing,
  checklist, module selection, support access, and the Billing Admin review queue.

## Complexity Tracking

> Documented per Constitution Governance ("Any complexity or deviation ... MUST be explicitly justified").
> Neither line below is a *violation* — both are read literally as satisfying Principle IV — but each
> introduces structure beyond the plan template's default, so it is recorded here for the record.

| Addition | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Separate control-plane PostgreSQL database (`kemfai_control`), outside any tenant's Odoo database | Accounts, the tenant registry itself, plans/entitlements, subscriptions, payment submissions, and support-access grants must exist and be queryable (e.g., by a Billing Admin across all tenants, FR-034) *before* a tenant database exists and *across* tenant boundaries by design — they cannot live inside a single tenant's isolated Odoo DB without contradicting Principle IV, and cannot live inside every tenant DB redundantly without breaking single-source-of-truth and Billing Admin's cross-tenant queue view. | Storing this data inside one arbitrarily-chosen tenant's database would violate Principle IV (that tenant could see or affect platform data) and would not scale to a cross-tenant Billing Admin queue; storing it redundantly per-tenant would break idempotency/consistency guarantees (Principle VII) and duplicate the audit trail. |
| Two Keycloak realms (`kemfai-customers`, `kemfai-internal`) | Customer identities (Workspace Owner, future customer roles) and internal KEMFAI staff identities (Billing Admin, Support, Super Admin) are different trust domains with different lifecycle, password/MFA policy, and blast radius if compromised; FR-004/FR-005 require the system to categorically prevent a customer identity from ever holding a Billing Admin or Support role. | A single shared realm with role-based separation was rejected because a misconfigured role assignment or client-scope leak would let a customer-domain credential reach staff-only APIs — an unacceptable risk for a financial SaaS handling payment approval and support access to customer workspaces. |
