# Tasks: KEMFAI Slice 1 — SaaS Onboarding Shell

**Input**: Design documents from `/specs/001-saas-onboarding-shell/` (plan.md, spec.md, data-model.md,
research.md, contracts/openapi.yaml, contracts/events.md, quickstart.md)

**Prerequisites**: plan.md (required, read), spec.md (required, read), data-model.md, research.md, contracts/
(all read). `.specify/memory/constitution.md` v1.0.0 (read) and `AGENTS.md` (read) govern role assignment and
gate discipline below.

**Tests**: Included and **not optional** for this feature. Constitution Quality Gates and plan.md's Test
Strategy section explicitly require automated coverage of tenant isolation, authorization, idempotency, and
source linkage, plus EN/AR-RTL and accessibility coverage for every screen (FR-013/FR-014) — tasks.md carries
that as concrete per-story test tasks so it cannot be narrowed at implementation time.

**Organization**: Tasks are grouped by user story (spec.md priorities) to enable independent implementation,
testing, and delivery of each story. Trial/entitlement values (FR-030a) are treated as admin-configurable data
throughout — no task may introduce an `if plan == X` branch; see T009/T010/T015.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Maps the task to a user story (US1–US8) for traceability; absent for Setup/Foundational/Polish
- Every task lists exact file paths, its **Dependencies**, its **Acceptance Criteria**, and its
  **Roles** (Primary / Backup / Reviewer), per `AGENTS.md`'s "every important task has Primary + Backup +
  Reviewer" rule and "no model approves its own implementation" rule.

## Role legend (from AGENTS.md)

| Short name | Full role |
|---|---|
| Claude | Spec + Frontend (Next.js UI, complex integration; primary spec author) |
| GLM | GLM-5.2, Backend builder (Odoo backend, NestJS APIs, CRUD, migrations) |
| Codex | Reviewer (code review, automated tests, security/code audit, final acceptance) |
| Gemini | Cross-check (consistency across artifacts, docs, UI review) |

No task's Reviewer equals its Primary (Constitution "No self-review"; AGENTS.md rule 6).

## Path Conventions

Per plan.md's Project Structure: `frontend/` (Next.js 15), `backend/api/` (NestJS 10 BFF), `backend/addons/`
(Odoo 18 Community `kemfai_*` modules only), `infra/` (docker/keycloak/provisioning).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization across the three-tier monorepo structure locked in plan.md/GATE0_DECISIONS.md.

- [X] T001 Initialize `backend/api` NestJS 10 project scaffold (`package.json`, `tsconfig.json`, `nest-cli.json`,
  `src/main.ts`, `src/app.module.ts`) with `@nestjs/core`, `@nestjs/swagger`, `class-validator`,
  `class-transformer`, `@nestjs/bullmq` dependencies in `backend/api/`
  - **Dependencies**: None
  - **Acceptance Criteria**: `npm run start` boots an empty NestJS app; no Odoo/DB code yet; matches
    plan.md's `backend/api/src/` structure skeleton (modules/, common/, integrations/, test/ directories present).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T002 [P] Initialize `frontend` Next.js 15 App Router project scaffold (`package.json`, `tsconfig.json`,
  `next.config.js`, `src/app/layout.tsx`) with `@carbon/react` and `next-intl` dependencies in `frontend/`
  - **Dependencies**: None
  - **Acceptance Criteria**: `npm run dev` boots an empty Next.js app; route groups
    `(public)/(auth)/(onboarding)/(internal)` exist as empty directories matching plan.md's Project Structure.
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

- [X] T003 [P] Extend `infra/docker/docker-compose.yml` with `keycloak`, `minio`, `redis`, `api`, and `frontend`
  services alongside the existing `kemfai-db` and `kemfai-odoo` services
  - **Dependencies**: None
  - **Acceptance Criteria**: `docker compose up` starts all seven services; Keycloak reachable on its admin
    port; MinIO console reachable; Redis reachable from `backend/api`'s configured `REDIS_URL`.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T004 [P] Configure shared ESLint + Prettier config for `backend/api` and `frontend` in
  `backend/api/.eslintrc.js` and `frontend/.eslintrc.js`
  - **Dependencies**: T001, T002
  - **Acceptance Criteria**: `npm run lint` runs clean on both empty scaffolds; consistent rule set (no
    conflicting TS/React rules) documented in each config's header comment.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T005 [P] Scaffold `kemfai_*` Odoo addon skeletons: `backend/addons/kemfai_tenant_core/__manifest__.py`,
  `backend/addons/kemfai_company_setup/__manifest__.py`, `backend/addons/kemfai_module_selection/__manifest__.py`,
  `backend/addons/kemfai_onboarding_checklist/__manifest__.py`, each depending only on Odoo Community `base`
  - **Dependencies**: None
  - **Acceptance Criteria**: Each addon installs cleanly on a scratch Odoo 18 Community DB with zero errors;
    no Odoo core file is touched (Constitution Principle II); no Enterprise/QuickBooks code is present.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Control-plane schema, cross-cutting guards/interceptors, identity topology, and integration clients
that every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T006 Configure the `kemfai_control` migration/ORM framework (e.g. TypeORM `DataSource`) pointed at a
  dedicated control-plane Postgres database, distinct from any `kemfai_tenant_<id>` database, in
  `backend/api/src/database/data-source.ts`
  - **Dependencies**: T001, T003
  - **Acceptance Criteria**: `npm run migration:run` connects to `kemfai_control` and applies an empty
    baseline migration; connecting to a tenant DB is structurally impossible from this data source (separate
    connection config).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T007 [P] Migration + entity: `Account` (id, keycloak_user_id, email citext unique, email_verified,
  mfa_enrolled, selected_plan_id, selected_billing_cycle, created_at, updated_at) in
  `backend/api/src/database/migrations/` and `backend/api/src/modules/accounts/entities/account.entity.ts`
  - **Dependencies**: T006
  - **Acceptance Criteria**: Migration creates a unique index on `email`; entity matches data-model.md's
    Account table verbatim; `Unverified → Verified` is the only state transition modeled.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T008 [P] Migration + entity: `Tenant` (id, account_id unique, status enum, odoo_db_name, minio_bucket,
  provisioning_attempts, failure_reason, created_at, ready_at) in `backend/api/src/database/migrations/` and
  `backend/api/src/modules/tenants/entities/tenant.entity.ts`
  - **Dependencies**: T006, T007
  - **Acceptance Criteria**: Unique constraint on `account_id` enforces 1:1 idempotent provisioning at the DB
    level (FR-023); `status` enum matches `Pending|Creating|Ready|Failed` exactly.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T009 [P] Migration + entities: `Plan`, `Feature`, `PlanFeatureEntitlement`, `PlanSetting`,
  `EntitlementDefault` in `backend/api/src/database/migrations/` and
  `backend/api/src/modules/entitlements/entities/`
  - **Dependencies**: T006
  - **Acceptance Criteria**: `PlanFeatureEntitlement` composite PK is `(plan_id, feature_key)`; `PlanSetting`
    carries `trial_window_days` (nullable, meaning "use default") and `auto_restrict_unpaid` (nullable, meaning
    "use default" — no in-column default value on either field, so there is no contradiction between a
    documented default and the "use default" sentinel, per I1 remediation, analysis.md) per FR-030a;
    `EntitlementDefault` is a singleton row seeded with `default_trial_window_days=14` AND
    `default_auto_restrict_unpaid=true`, mirroring the trial-window fallback pattern exactly for both fields; no
    plan-name string appears anywhere outside seed/test data (Constitution P-07).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T010 Implement `EntitlementsService` and `GET /entitlements/me` (reads `PlanFeatureEntitlement` /
  `PlanSetting` / `EntitlementDefault` only — falls back to `EntitlementDefault.default_trial_window_days` when
  `PlanSetting.trial_window_days` is null, and independently falls back to
  `EntitlementDefault.default_auto_restrict_unpaid` when `PlanSetting.auto_restrict_unpaid` is null) in
  `backend/api/src/modules/entitlements/entitlements.controller.ts` and `.service.ts`
  - **Dependencies**: T009
  - **Acceptance Criteria**: Response matches `EntitlementSet` schema in contracts/openapi.yaml exactly
    (planId, features[], trialWindowDays, autoRestrictUnpaid); both fallback paths (trial window and
    auto-restrict) are independently tested (I1 remediation, analysis.md); this is the **only** service any
    later module-selection, checklist-gating, or trial/auto-restriction check may call — grep of the codebase
    after later phases must show zero direct `PlanSetting`/`EntitlementDefault` reads outside this service
    (FR-030, FR-030a).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T011 [P] Migration + entity: `Subscription` (id, tenant_id, plan_id, billing_cycle, status enum,
  current_period_start/end, activated_at/by, created_at/updated_at) in
  `backend/api/src/database/migrations/` and `backend/api/src/modules/billing-customer/entities/subscription.entity.ts`
  - **Dependencies**: T006, T008, T009
  - **Acceptance Criteria**: `status` enum matches `PendingActivation|Active|Suspended|Cancelled`; a tenant
    has exactly one Subscription row (unique on `tenant_id`) per data-model.md.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T012 [P] Migration + entity: `PaymentSubmission` including the DB-level unique partial index on
  `(tenant_id, billing_period_start, billing_period_end) WHERE status IN ('PendingReview','MoreInfoRequested')`
  in `backend/api/src/database/migrations/` and
  `backend/api/src/modules/billing-customer/entities/payment-submission.entity.ts`
  - **Dependencies**: T006, T011
  - **Acceptance Criteria**: Attempting to insert a second unresolved row for the same tenant+period fails at
    the database constraint level, not only in application code (FR-033, Constitution Principle VII); includes
    `status_history` as an append-only jsonb array.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T013 [P] Migration + entities: `SupportAccessGrant`, `SupportAccessUsage` in
  `backend/api/src/database/migrations/` and `backend/api/src/modules/support-access/entities/`
  - **Dependencies**: T006, T008
  - **Acceptance Criteria**: `expires_at` is `NOT NULL` on `SupportAccessGrant` (mandatory expiry, FR-039);
    `SupportAccessUsage` has `was_denied` + `denial_reason` for logging denied attempts (FR-041).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T014 [P] Migration + entity: `AuditEvent`, with `UPDATE`/`DELETE` privileges revoked from the API/BFF's
  database role at the migration level, in `backend/api/src/database/migrations/` and
  `backend/api/src/modules/audit/entities/audit-event.entity.ts`
  - **Dependencies**: T006
  - **Acceptance Criteria**: Attempting an `UPDATE` or `DELETE` against this table using the API's DB role
    fails at the Postgres privilege level (FR-008 "immutable once written" enforced infrastructurally, not by
    convention).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T015 Seed script for dev/quickstart: `EntitlementDefault` singleton plus one published `Plan` with
  `Feature`/`PlanFeatureEntitlement`/`PlanSetting` rows in `backend/api/src/database/seeds/`
  - **Dependencies**: T009
  - **Acceptance Criteria**: Running the seed against a fresh `kemfai_control` DB makes `GET /public/plans`
    (once T031 exists) return exactly one published plan; `PlanSetting.trial_window_days` is left null on the
    seeded plan specifically to exercise the `EntitlementDefault` fallback path end-to-end.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T016 Author Keycloak realm exports `infra/keycloak/kemfai-customers-realm.json` (Workspace Owner role,
  `VERIFY_EMAIL` + `CONFIGURE_TOTP` required actions enabled) and `infra/keycloak/kemfai-internal-realm.json`
  (Billing Admin, Support, Super Admin, Customer Success, Technical Admin roles), wired into the docker-compose
  realm-import volume from T003
  - **Dependencies**: T003
  - **Acceptance Criteria**: Fresh `docker compose up` auto-imports both realms; no role or client scope
    exists that would let a `kemfai-customers` user obtain a `kemfai-internal` role (Constitution Complexity
    Tracking, FR-004).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T017 Implement request-scoped `TenantContext` resolution and `TenantScopeGuard` (denies cross-tenant
  access, emits `tenant_access.denied_cross_tenant`) in `backend/api/src/common/tenant-context/` and
  `backend/api/src/common/guards/tenant-scope.guard.ts`
  - **Dependencies**: T007, T008
  - **Acceptance Criteria**: Applied globally (not per-endpoint); a request bearing Tenant A's token
    attempting to resolve any Tenant B resource returns 403/404 and writes the audit event before the guard
    exits (FR-001, SC-004).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T018 [P] Implement `RoleGuard` enforcing the Roles & Scopes table (data-model.md) identically for
  UI-driven and raw HTTP calls in `backend/api/src/common/guards/role.guard.ts`
  - **Dependencies**: T016
  - **Acceptance Criteria**: A single guard implementation is reused on every mutating endpoint; no
    per-endpoint duplicate authorization logic exists (FR-006 satisfied structurally).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T019 Implement `AuditService` and `AuditEventInterceptor` (writes the full FR-007 event catalog from
  contracts/events.md, append-only) in `backend/api/src/modules/audit/audit.service.ts` and
  `backend/api/src/common/interceptors/audit-event.interceptor.ts`
  - **Dependencies**: T014
  - **Acceptance Criteria**: Every action listed in contracts/events.md's catalog table has a corresponding
    emission call site reachable from `AuditService`; every emitted event carries `actor_type`, `actor_id`
    (or null for system), `tenant_id` (or null pre-tenant), `subject_type`/`subject_id`, `occurred_at`, and
    `payload` (FR-008).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T020 [P] Implement `IdempotencyKeyInterceptor` for mutating endpoints in
  `backend/api/src/common/interceptors/idempotency.interceptor.ts`
  - **Dependencies**: T017
  - **Acceptance Criteria**: Replaying an identical mutating request with the same idempotency key returns the
    original result rather than re-executing side effects (Constitution Principle VII).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T021 Wire BullMQ + Redis module and register the five queues (`tenant.provision`,
  `email.send_verification`, `notification.billing_decision`, `support_access.expiry_sweep`,
  `trial.expiry_sweep`) in `backend/api/src/app.module.ts`
  - **Dependencies**: T001, T003
  - **Acceptance Criteria**: All five queues are visible via BullMQ's admin/inspection API against the
    docker-compose Redis instance; each queue's job-id/dedupe-key strategy matches contracts/events.md's table.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T022 Wire Swagger/OpenAPI bootstrap in `backend/api/src/main.ts` so the live BFF conforms to
  `contracts/openapi.yaml` (tags, schemas, `bearerAuth` security scheme)
  - **Dependencies**: T001
  - **Acceptance Criteria**: `/api-docs` (or equivalent) renders every path/tag from contracts/openapi.yaml;
    later contract tests can diff the live spec against the committed file with zero drift.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T023 [P] Setup `next-intl` locale routing, EN/AR message catalog skeleton, and dir-aware root layout
  (`dir="rtl"|"ltr"` on `<html>`) in `frontend/src/lib/i18n/`, `frontend/src/locales/en/`,
  `frontend/src/locales/ar/`, and `frontend/src/app/layout.tsx`
  - **Dependencies**: T002
  - **Acceptance Criteria**: Switching locale re-renders the root layout with `dir="rtl"` for Arabic and
    `dir="ltr"` for English, with no layout content lost (Constitution Principle V, FR-014).
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

- [X] T024 [P] Generate typed API client from `contracts/openapi.yaml` into `frontend/src/lib/api-client/`
  - **Dependencies**: T002, T022, T113
  - **Acceptance Criteria**: Generated client's request/response types match every schema in
    contracts/openapi.yaml with no manual `any` overrides, including the `PATCH /accounts/me/locale` path added
    by T113 (Round 2 remediation — see analysis.md).
  - **Roles**: Primary: Claude · Backup: GLM · Reviewer: Codex

- [X] T025 [P] Implement MinIO integration module (bucket-per-tenant client + presigned URL helper) in
  `backend/api/src/integrations/minio/`
  - **Dependencies**: T001, T003
  - **Acceptance Criteria**: Module exposes `createTenantBucket(tenantId)` and
  `getPresignedUploadUrl`/`getPresignedDownloadUrl`; bucket policy denies all access except the API/BFF's
    service credentials (research.md §5).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T026 [P] Implement Odoo JSON-RPC client integration module (one connection profile per tenant database)
  in `backend/api/src/integrations/odoo-rpc/`
  - **Dependencies**: T001, T003
  - **Acceptance Criteria**: Module can open a JSON-RPC session against an arbitrary `kemfai_tenant_<id>`
    database name passed at call time; no shared/global Odoo session leaks a previous tenant's DB context
    between calls.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T099 [P] Migration + entity: `FeatureFlag` (feature_key PK/FK → Feature.key, enabled boolean default
  false, notes text nullable) and extend `EntitlementsService`/`GET /entitlements/me` to expose per-feature flag
  state, satisfying Constitution Principle VI ("incomplete modules MUST sit behind feature flags") via the same
  config-driven structure as FR-030a rather than a second ad-hoc mechanism, in
  `backend/api/src/database/migrations/`, `backend/api/src/modules/entitlements/entities/feature-flag.entity.ts`,
  and `entitlements.service.ts` (C1 remediation — see analysis.md)
  - **Dependencies**: T009, T010
  - **Acceptance Criteria**: `FeatureFlag` rows default `enabled=false` (safe default is hidden); toggling
    `enabled` requires no code deploy; `EntitlementsService` is the only place `FeatureFlag` is read (same
    single-source-of-truth rule as T010) — a grep of the codebase after later phases must show zero direct
    `FeatureFlag` reads outside this service.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T100 [P] Implement `FeatureFlagGuard`, applied to any customer-facing route/UI surface for a module not
  yet fully complete, denying/hiding access when `FeatureFlag.enabled=false`, in
  `backend/api/src/common/guards/feature-flag.guard.ts` (C1 remediation — see analysis.md)
  - **Dependencies**: T099
  - **Acceptance Criteria**: A single reusable guard implementation is applied identically to UI-driven and raw
    HTTP paths (FR-006-style enforcement, no per-endpoint duplicate gating logic); US4/US7/US8's main
    implementation tasks (T076/T082/T088) each declare this guard as a required acceptance criterion.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T101 [P] Implement `TrialWindowGuard` — computes elapsed time since `Tenant.ready_at` against
  `EntitlementsService`'s resolved `trialWindowDays`, and denies onboarding-scoped access (company setup, module
  selection, checklist) when elapsed exceeds the window, the resolved `autoRestrictUnpaid` is true, and the
  tenant's Subscription is not `Active`, in `backend/api/src/common/guards/trial-window.guard.ts` (F2
  remediation — see analysis.md; FR-030a)
  - **Dependencies**: T008, T010, T011
  - **Acceptance Criteria**: An `Active` Subscription always bypasses the guard regardless of elapsed time; a
    plan resolving `autoRestrictUnpaid=false` (via `PlanSetting`/`EntitlementDefault`, see T009) never restricts;
    all values are read exclusively via `EntitlementsService`, never hard-coded; enforcement is applied
    identically to UI-driven and raw HTTP paths.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T102 Implement the `trial.expiry_sweep` BullMQ scheduled job (every 30 seconds, mirroring
  `support_access.expiry_sweep`/T090) that proactively detects newly-crossed-threshold unpaid tenants and emits
  `tenant.trial.restricted`, in `backend/api/src/integrations/provisioning/trial-expiry-sweep.processor.ts` (F2
  remediation — see analysis.md)
  - **Dependencies**: T021, T101
  - **Acceptance Criteria**: Running the sweep twice in the same tick window does not double-audit a tenant
    (mirrors T086's idempotency guarantee); a tenant whose Subscription becomes `Active` before the sweep runs
    is never restricted; the sweep is observability/notification only — live access denial is always enforced by
    `TrialWindowGuard` (T101), not by this job.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T113 [P] Contract-first addition: add `PATCH /accounts/me/locale` (path, `LocaleUpdateRequest` schema,
  200/422 responses) to `contracts/openapi.yaml`, so the T024 generated frontend client and the T104
  implementation both consume a committed contract rather than an endpoint introduced only in tasks.md prose, in
  `contracts/openapi.yaml` (Round 2 remediation — see analysis.md; closes the contract gap left by U2's original
  T103/T104 addition)
  - **Dependencies**: None (contract authoring only; no code)
  - **Acceptance Criteria**: `contracts/openapi.yaml` documents `PATCH /accounts/me/locale` with a
    `LocaleUpdateRequest` schema (`locale` enum `[en, ar]`) and 200/422 responses; this task is an explicit
    dependency of T024 (client generation, which must regenerate typed client code against this path) and of
    T104 (implementation, which must match this schema exactly) — both are ordered strictly after this task.
  - **Roles**: Primary: Claude · Backup: GLM · Reviewer: Codex

**Checkpoint**: Foundation ready — control-plane schema, guards (including feature-flag/module-gating and
trial-window enforcement), audit, queues, i18n, integration clients, and the locale-endpoint contract exist.
User story implementation can now begin.

---

## Phase 3: User Story 1 - Select a plan and create a verified account (Priority: P1) 🎯 MVP

**Goal**: A prospective customer selects a plan, signs up with email/password, verifies their email, and may
enroll MFA — with no tenant/workspace created until verification (FR-016–FR-021).

**Independent Test**: Complete plan selection and signup with a real-looking email; confirm no
tenant/workspace exists until the verification link is used, and the account cannot access anything beyond a
"verify your email" state until then.

### Tests for User Story 1

- [X] T027 [P] [US1] Contract test: `POST /accounts/signup`, `POST /accounts/verify-email`,
  `POST /accounts/resend-verification`, `POST /accounts/mfa/enroll`, `POST /accounts/mfa/confirm` against
  `contracts/openapi.yaml` in `backend/api/test/contract/accounts.contract-spec.ts`
  - **Dependencies**: T022
  - **Acceptance Criteria**: Every documented response code (201/409/422/200/410/202) is exercised at least
    once and matches the declared schema.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [X] T028 [P] [US1] Integration test: signup against an already-verified email returns a generic rejection
  without leaking account existence; signup against an unverified email resends verification instead of
  creating a second `Account` row in `backend/api/test/integration/accounts-signup.integration-spec.ts`
  - **Dependencies**: T007
  - **Acceptance Criteria**: Asserts exactly one `Account` row exists in both cases (Acceptance Scenario 1.6,
    Edge Cases).
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [X] T029 [P] [US1] Integration test: verification-link reuse/supersession — only the most recently issued,
  unexpired link is honored; earlier links are rejected in
  `backend/api/test/integration/accounts-verification.integration-spec.ts`
  - **Dependencies**: T007
  - **Acceptance Criteria**: Issuing a second verification email invalidates the first; using the first
    afterward returns 410 (Edge Cases, FR-021).
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [X] T030 [P] [US1] Playwright EN/AR-RTL + axe accessibility test for the public plan list, signup, verify,
  and MFA enrollment screens in `frontend/tests/e2e/us1-signup.spec.ts`
  - **Dependencies**: T023
  - **Acceptance Criteria**: Zero axe violations in either locale; full RTL mirroring asserted in Arabic
    (FR-013, FR-014, SC-005); localized signup/verification error states render (FR-012).
  - **Roles**: Primary: Codex · Backup: Claude · Reviewer: Gemini

- [x] T103 [P] [US1] Integration/e2e test: a locale choice persists across a fresh login session, not merely an
  immediate dir re-render — log out, clear client-side-only state, log back in, and assert the previously chosen
  locale (not the browser default) is applied, in `frontend/tests/e2e/locale-persistence.spec.ts` (U2
  remediation — see analysis.md)
  - **Dependencies**: T023, T007
  - **Acceptance Criteria**: Matches FR-024's "persisted for their subsequent sessions"; explicitly distinct
    from T023's immediate re-render check and from T030's single-session RTL assertions.
  - **Roles**: Primary: Codex · Backup: Claude · Reviewer: Gemini

### Implementation for User Story 1

- [X] T031 [US1] Implement `GET /public/plans` returning published `PlanSummary` list sourced from
  `PlanFeatureEntitlement` (empty state per FR-011) in `backend/api/src/modules/plans/plans.controller.ts` and
  `plans.service.ts`
  - **Dependencies**: T009, T015
  - **Acceptance Criteria**: Unpublished plans never appear; response matches `PlanSummary` schema; empty
    array (not an error) when no plan is published.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T032 [US1] Implement `POST /accounts/signup` (email format + weak-password rejection, Keycloak
  `kemfai-customers` user creation, carries `selected_plan_id`/`selected_billing_cycle`, enqueues
  `email.send_verification`, emits `account.created`) in
  `backend/api/src/modules/accounts/accounts.controller.ts` and `accounts.service.ts`
  - **Dependencies**: T007, T016, T021, T019
  - **Acceptance Criteria**: Matches Acceptance Scenarios 1.1/1.2; re-validates that the referenced plan is
    still published, prompting re-selection if not (Edge Cases).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T033 [US1] Implement `POST /accounts/verify-email` (consumes the Keycloak `VERIFY_EMAIL` token, sets
  `email_verified`, enqueues `tenant.provision`, emits `account.email_verified`) in
  `backend/api/src/modules/accounts/accounts.service.ts`
  - **Dependencies**: T032
  - **Acceptance Criteria**: Matches Acceptance Scenario 1.3; expired/invalid/superseded tokens return 410
    (Edge Cases).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T034 [US1] Implement `POST /accounts/resend-verification` (invalidates the prior link, issues a new one,
  no account-existence leak) in `backend/api/src/modules/accounts/accounts.controller.ts`
  - **Dependencies**: T032
  - **Acceptance Criteria**: Matches Acceptance Scenario 1.5; always returns 202 regardless of whether the
    email exists.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T035 [US1] Implement `POST /accounts/mfa/enroll` and `POST /accounts/mfa/confirm` via Keycloak
  `CONFIGURE_TOTP` required action, emits `account.mfa_enrolled` in
  `backend/api/src/modules/accounts/mfa.controller.ts`
  - **Dependencies**: T032
  - **Acceptance Criteria**: Matches Acceptance Scenario 1.4; MFA enrollment is never a blocking precondition
    to continue onboarding (FR-020).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T036 [P] [US1] Build the public plan-selection page (pricing, feature summary, EN/AR/RTL) carrying
  plan+cycle choice into signup without re-entry in `frontend/src/app/(public)/plans/page.tsx`
  - **Dependencies**: T024, T031
  - **Acceptance Criteria**: Matches Acceptance Scenario 1.1; empty state renders when no plan is published
    (FR-011); fully keyboard-operable (FR-013).
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

- [X] T037 [P] [US1] Build the signup form page (email/password/terms, localized validation errors) in
  `frontend/src/app/(auth)/signup/page.tsx`
  - **Dependencies**: T024, T032, T036
  - **Acceptance Criteria**: Matches Acceptance Scenarios 1.2/1.6; malformed email/weak password/duplicate
    email each show a distinct, localized error (FR-012).
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

- [X] T038 [P] [US1] Build the verify-email screen (token consumption, expired/invalid/reused error states)
  and resend-verification action in `frontend/src/app/(auth)/verify/page.tsx`
  - **Dependencies**: T024, T033, T034
  - **Acceptance Criteria**: Matches Acceptance Scenarios 1.3/1.5; error states are actionable, not blank
    (FR-012).
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

- [X] T039 [P] [US1] Build the MFA enrollment screen (TOTP QR/confirm flow, optional/non-blocking) in
  `frontend/src/app/(auth)/mfa/page.tsx`
  - **Dependencies**: T024, T035
  - **Acceptance Criteria**: Matches Acceptance Scenario 1.4; user can skip and return to onboarding without
    enrolling.
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

- [x] T104 [US1] Implement locale persistence: `PATCH /accounts/me/locale` (sets `Account.preferred_locale`) and
  wire `next-intl`'s initial locale resolution to read it on login/session-refresh, extending T023's dir-aware
  layout to prefer the persisted Account value over browser-detected locale once authenticated, in
  `backend/api/src/modules/accounts/accounts.controller.ts` and `frontend/src/lib/i18n/` (U2 remediation — see
  analysis.md; contract added via T113 in Round 2 remediation — see analysis.md)
  - **Dependencies**: T007, T023, T032, T113
  - **Acceptance Criteria**: Matches FR-024; a locale switch made in one session is still in effect after
    logging out and back in in a fresh session/browser context (T103); pre-authentication (public plan list,
    signup) still uses browser/URL-driven locale detection, unaffected by this task; request/response shape
    matches the `PATCH /accounts/me/locale` contract added by T113 exactly.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

**Checkpoint**: User Story 1 fully functional and independently testable — a verified, plan-associated identity
ready for provisioning.

---

## Phase 4: User Story 2 - Automatic tenant, workspace, and initial company provisioning (Priority: P1)

**Goal**: On email verification, automatically and idempotently create an isolated tenant/workspace, dedicated
database, and initial company, with the verifying user as Workspace Owner (FR-022/FR-023).

**Independent Test**: Verify an account and confirm a new tenant/workspace and dedicated database are created,
an initial company shell exists, the acting user is workspace owner, and no other tenant's data is visible.

### Tests for User Story 2

- [X] T040 [P] [US2] Integration test: N concurrent and sequential retries of the same verified-account
  provisioning request yield exactly one Tenant row, one Odoo database, one initial Company, one MinIO bucket
  in `backend/api/test/integration/tenant-provisioning.integration-spec.ts`
  - **Dependencies**: T008
  - **Acceptance Criteria**: Matches Acceptance Scenario 2.5 and plan.md's Idempotency test strategy exactly.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [X] T041 [P] [US2] Integration test: provision two tenants end-to-end and assert the two Odoo databases and
  two MinIO buckets are physically distinct in `backend/api/test/integration/tenant-isolation.integration-spec.ts`
  - **Dependencies**: T008
  - **Acceptance Criteria**: Matches Acceptance Scenario 2.2 and plan.md's Tenant Isolation "Data-level" test
    strategy (physical, not merely logical, separation).
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [X] T042 [P] [US2] Contract test: cross-tenant denial on `GET /tenants/me` and `GET /companies/current/setup`
  using a second tenant's account token, asserting 403/404 plus a `tenant_access.denied_cross_tenant` audit
  event, in `backend/api/test/contract/tenant-isolation.contract-spec.ts`
  - **Dependencies**: T017
  - **Acceptance Criteria**: Matches SC-004; 100% of these customer-facing surfaces have at least one
    cross-tenant-denial test.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [X] T043 [P] [US2] Playwright test: "setting up your workspace" loading state and actionable failure state
  (retry/contact support) render correctly in EN/AR in `frontend/tests/e2e/us2-provisioning.spec.ts`
  - **Dependencies**: T023
  - **Acceptance Criteria**: Matches Acceptance Scenarios 2.3/2.4; no blank/frozen screen during polling
    (FR-010).
  - **Roles**: Primary: Codex · Backup: Claude · Reviewer: Gemini

### Implementation for User Story 2

- [x] T044 [US2] Implement the `tenant.provision` BullMQ processor: create-if-not-exists `Tenant` row; emit
  `tenant.provisioning.attempted`; call `createTenantBucket(tenantId)` (MinIO, T025) to provision the tenant's
  MinIO bucket and set `Tenant.minio_bucket` — sequenced explicitly ahead of Odoo DB creation, per plan.md's
  Storage section and data-model.md's Tenant "Provisioning order" note (F1 remediation — see analysis.md) —
  then create `kemfai_tenant_<id>` Odoo database via JSON-RPC, install `kemfai_*` addons, seed one initial
  `res.company`, create the initial `Subscription` row (status `PendingActivation`) for the account's selected
  plan/cycle, mark Tenant `Ready` and emit `tenant.provisioning.succeeded`; on any failure mark `Failed` and emit
  `tenant.provisioning.failed` without leaving a partially-usable workspace — all three lifecycle events
  (`.attempted`/`.succeeded`/`.failed`) per contracts/events.md are required, not `.failed` alone (F5
  remediation — see analysis.md), in `backend/api/src/integrations/provisioning/tenant-provision.processor.ts`
  - **Dependencies**: T008, T011, T025, T026, T021, T019
  - **Acceptance Criteria**: Matches Acceptance Scenarios 2.1/2.4/2.5; each step is individually
    idempotent ("create if not exists"); no cross-tenant or shared-database fallback ever occurs (Edge Cases);
    `Tenant.minio_bucket` is set and verifiable before Odoo DB creation begins, satisfying T040/T041's
    bucket-exists assertions and unblocking T062's proof upload; all three lifecycle audit events are emitted at
    their respective points, each independently assertable in tests.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T045 [US2] Implement `GET /tenants/me` (poll `Pending|Creating|Ready|Failed`) and
  `POST /tenants/me/provisioning-retry` (409 no-op if already `Ready`/`Creating`) in
  `backend/api/src/modules/tenants/tenants.controller.ts`
  - **Dependencies**: T044
  - **Acceptance Criteria**: Matches Acceptance Scenario 2.3 and the quickstart's retry-after-Ready 409 check.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T046 [US2] Assign the verifying Account the Workspace Owner role scoped to its Tenant in the
  `kemfai-customers` Keycloak realm (custom `tenant_id` attribute) on provisioning success, in
  `backend/api/src/integrations/provisioning/tenant-provision.processor.ts`
  - **Dependencies**: T044, T016
  - **Acceptance Criteria**: Matches Acceptance Scenario 2.1; the role/tenant binding is visible in
    subsequent `RoleGuard`/`TenantScopeGuard` checks.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [x] T047 [US2] Implement the `kemfai_tenant_core` Odoo addon's initial-company bootstrap (creates the one
  initial `res.company` per tenant database) in `backend/addons/kemfai_tenant_core/models/` and `data/`
  - **Dependencies**: T005
  - **Acceptance Criteria**: Installing the addon on a scratch tenant DB produces exactly one company record
    with no pre-populated financial data (out of scope for this slice).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T048 [P] [US2] Build the "setting up your workspace" provisioning poll/loading screen and failure/retry
  screen in `frontend/src/app/(onboarding)/provisioning/page.tsx`
  - **Dependencies**: T024, T045
  - **Acceptance Criteria**: Matches Acceptance Scenarios 2.3/2.4; retry action calls
    `/tenants/me/provisioning-retry`; "contact support" path is present on failure.
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

**Checkpoint**: Stories 1 and 2 together deliver a verified, provisioned, isolated tenant ready for company
setup.

---

## Phase 5: User Story 3 - Configure the company through the setup wizard (Priority: P1)

**Goal**: The Workspace Owner completes country/identity/currency/fiscal-year/VAT/industry/accounting-setup in
KEMFAI's own bilingual, fully RTL-mirrored UI (FR-025–FR-028).

**Independent Test**: Against an already-provisioned tenant, step through the wizard in English and Arabic;
confirm every field persists, RTL fully mirrors, and no native Odoo UI/URL/terminology is exposed.

### Tests for User Story 3

- [X] T049 [P] [US3] Contract test: `GET`/`PUT /companies/current/setup` and
  `POST /companies/current/setup/complete` against `contracts/openapi.yaml` in
  `backend/api/test/contract/company-setup.contract-spec.ts`
  - **Dependencies**: T022
  - **Acceptance Criteria**: 200/422/409 response codes each exercised and schema-conformant.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T050 [P] [US3] Integration test: country-dependent VAT/tax validation, including the missing-rule
  configuration-gap 409 in `backend/api/test/integration/company-setup-validation.integration-spec.ts`
  - **Dependencies**: T026
  - **Acceptance Criteria**: Matches Acceptance Scenario 3.5/3.6 and the Edge Case "must not silently accept
    unvalidated data."
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T051 [P] [US3] Odoo addon test: `kemfai_company_setup` wizard-state persistence, resume-at-first-
  incomplete-step, and last-write-wins concurrency indicator in
  `backend/addons/kemfai_company_setup/tests/test_company_setup.py`
  - **Dependencies**: T005
  - **Acceptance Criteria**: Matches Acceptance Scenarios 3.3/3.4 and the Edge Case for two concurrent wizard
    sessions.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T052 [P] [US3] Playwright EN/AR-RTL + axe test: full wizard walkthrough including a mid-wizard language
  switch that preserves unsaved input, in `frontend/tests/e2e/us3-company-setup.spec.ts`
  - **Dependencies**: T023
  - **Acceptance Criteria**: Matches Acceptance Scenario 3.2 and the Edge Case for language switch mid-flow;
    zero axe violations in both locales.
  - **Roles**: Primary: Codex · Backup: Claude · Reviewer: Gemini

- [ ] T105 [P] [US3] Contract test: `GET`/`PUT /companies/current/settings` — a distinct post-completion surface
  from the setup wizard — against `contracts/openapi.yaml` in
  `backend/api/test/contract/company-settings.contract-spec.ts` (F3 remediation — see analysis.md; status-code
  contradiction with T106 reconciled in Round 2 remediation — see analysis.md)
  - **Dependencies**: T022
  - **Acceptance Criteria**: 200/403/409 response codes exercised and schema-conformant, exactly as documented
    in `contracts/openapi.yaml`'s `/companies/current/settings` path (the sole canonical source for these
    codes); specifically asserts the pre-completion (`Company.setup_complete=false`) case returns **409** with a
    response body conforming to the `CompanySetupIncompleteError` schema (`contracts/openapi.yaml`), not any
    other code or shape — this test must not restate or diverge from the code/schema documented in the
    contract, and T106 is the implementation that must match it exactly.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

### Implementation for User Story 3

- [X] T053 [US3] Implement the `kemfai_company_setup` Odoo addon: fields on `res.company` (country, legal_name,
  trade_name, base_currency, fiscal_year_start_month/day, vat_tax_registration, industry,
  accounting_setup_template, setup_wizard_step, setup_complete, setup_completed_at) plus a per-country
  validation-rule table, in `backend/addons/kemfai_company_setup/models/`
  - **Dependencies**: T047
  - **Acceptance Criteria**: Matches data-model.md's Company table verbatim; a launch country with no rule
    defined blocks with a configuration-gap signal rather than accepting the value (Edge Cases).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [x] T054 [US3] Implement `GET`/`PUT /companies/current/setup` (step save, resume at first incomplete step,
  country-specific validation, configuration-gap 409) via Odoo JSON-RPC, guarded by `TrialWindowGuard` (T101) so
  a past-window unpaid tenant is denied identically to the other two FR-030a onboarding surfaces, in
  `backend/api/src/modules/company-setup/company-setup.controller.ts` and `.service.ts`
  - **Dependencies**: T026, T053, T101
  - **Acceptance Criteria**: Matches Acceptance Scenarios 3.1/3.3/3.4/3.5/3.6; `TrialWindowGuard` (T101) is
    applied to this endpoint and denies both the documented UI-shaped call and a raw HTTP replay identically once
    the trial window has elapsed with `autoRestrictUnpaid` resolved true and no `Active` Subscription — this is
    one of the three FR-030a onboarding paths (company setup, module selection T076, checklist T082) that must
    each carry this guard explicitly (Round 2 remediation — see analysis.md).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [x] T055 [US3] Implement `POST /companies/current/setup/complete` (marks `setup_complete` only when all
  required steps are submitted, emits `company.setup.completed`) in
  `backend/api/src/modules/company-setup/company-setup.service.ts`
  - **Dependencies**: T054
  - **Acceptance Criteria**: Matches Acceptance Scenario 3.7; values remain editable afterward through company
    settings (FR-028), not only by re-running the wizard.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [X] T056 [P] [US3] Build the company setup wizard UI (country, identity, currency, fiscal year, VAT/tax,
  industry, accounting-setup steps; fixed order with progress indicator; EN/AR/RTL; pause/resume) in
  `frontend/src/app/(onboarding)/setup-wizard/`
  - **Dependencies**: T024, T054, T055
  - **Acceptance Criteria**: Matches Acceptance Scenarios 3.1–3.7; fully keyboard-operable and RTL-mirrored
    (FR-013/FR-014).
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

- [ ] T106 [US3] Implement `GET`/`PUT /companies/current/settings` — a distinct endpoint reachable only once
  `Company.setup_complete=true`, allowing authorized users to edit the same setup-wizard-captured fields
  afterward without re-running the wizard, emitting `company.settings.updated` (distinct from
  `company.setup.completed`) — via Odoo JSON-RPC, in
  `backend/api/src/modules/company-setup/company-settings.controller.ts` and `.service.ts` (F3 remediation —
  see analysis.md; FR-028; status-code contradiction with T105 reconciled in Round 2 remediation — see
  analysis.md)
  - **Dependencies**: T055
  - **Acceptance Criteria**: Matches FR-028's "editable afterward through company settings, not only by
    re-running the wizard"; a call before `setup_complete=true` is rejected with the single canonical **409**
    documented on the `GET`/`PUT /companies/current/settings` path in `contracts/openapi.yaml`, with a response
    body conforming to the `CompanySetupIncompleteError` schema (added by this remediation pass — no longer
    deferred), directing the caller to the wizard (T054) instead; only Workspace Owner may call it, enforced by
    `RoleGuard`/`TenantScopeGuard`; the response code and schema this implementation returns MUST match
    `contracts/openapi.yaml`'s `CompanySetupIncompleteError` exactly, which is now the single source of truth
    T105's contract test validates against.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T107 [P] [US3] Build the company settings screen (post-completion editing of country/identity/currency/
  fiscal-year/VAT/industry/accounting-setup fields, reachable independently of the setup wizard) in
  `frontend/src/app/(onboarding)/company-settings/page.tsx` (F3 remediation — see analysis.md; FR-028)
  - **Dependencies**: T024, T106
  - **Acceptance Criteria**: Matches FR-028; editing a field after setup completion does not require
    re-entering the wizard; fully keyboard-operable and RTL-mirrored (FR-013/FR-014).
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

**Checkpoint**: Stories 1–3 deliver a verified, provisioned, fully-configured company — the proving ground for
"no native Odoo UI" and bilingual/RTL support.

---

## Phase 6: User Story 5 - Submit manual bank-transfer payment proof for activation (Priority: P1)

**Goal**: The customer views bank-transfer instructions/reference and submits payment proof, moving the
subscription to "Pending Review" (FR-031–FR-033).

**Independent Test**: Against a workspace with a pending subscription, display instructions/reference, upload a
proof document, submit it, and confirm the submission enters "Pending Review" visible to the customer.

### Tests for User Story 5

- [ ] T057 [P] [US5] Contract test: `GET /billing/subscription` and `GET`/`POST /billing/payment-submissions`
  against `contracts/openapi.yaml` in `backend/api/test/contract/billing-customer.contract-spec.ts`
  - **Dependencies**: T022
  - **Acceptance Criteria**: 200/201/409/422 response codes each exercised and schema-conformant.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T058 [P] [US5] Integration test: the DB-level unique partial index rejects a second concurrent
  PendingReview/MoreInfoRequested submission for the same tenant+billing period in
  `backend/api/test/integration/payment-submission-uniqueness.integration-spec.ts`
  - **Dependencies**: T012
  - **Acceptance Criteria**: Matches FR-033 and plan.md's Idempotency "Payment submission" test strategy
    (constraint-level rejection, defense in depth).
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T059 [P] [US5] Integration test: an unsupported file type or over-size upload is rejected (422) with no
  `PaymentSubmission` row created in `backend/api/test/integration/payment-submission-upload.integration-spec.ts`
  - **Dependencies**: T012
  - **Acceptance Criteria**: Matches Acceptance Scenario 5.4.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T060 [P] [US5] Playwright EN/AR-RTL + axe test: billing screen instructions/reference/amount/period,
  proof upload happy path, and duplicate-submission block in `frontend/tests/e2e/us5-billing-customer.spec.ts`
  - **Dependencies**: T023
  - **Acceptance Criteria**: Matches Acceptance Scenarios 5.1–5.3; localized upload-error messaging (FR-012).
  - **Roles**: Primary: Codex · Backup: Claude · Reviewer: Gemini

### Implementation for User Story 5

- [ ] T061 [US5] Implement `GET /billing/subscription` (bank instructions, amount, currency, billing period,
  unique payment reference) in `backend/api/src/modules/billing-customer/billing-customer.controller.ts`
  - **Dependencies**: T011, T044
  - **Acceptance Criteria**: Matches Acceptance Scenario 5.1.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T062 [US5] Implement `GET`/`POST /billing/payment-submissions` (file-type/size validation before row
  creation, MinIO proof upload, append-only `status_history`, emits `billing.payment_submission.created`, 409
  on unresolved duplicate) in `backend/api/src/modules/billing-customer/billing-customer.service.ts`
  - **Dependencies**: T012, T025, T061
  - **Acceptance Criteria**: Matches Acceptance Scenarios 5.2/5.3/5.4/5.5.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T063 [P] [US5] Build the billing screen (instructions/reference/amount/period, status display) and
  proof-upload form with localized upload errors in `frontend/src/app/(onboarding)/billing/page.tsx`
  - **Dependencies**: T024, T062
  - **Acceptance Criteria**: Matches Acceptance Scenarios 5.1–5.4; status remains visible without requiring
    the admin side to act (Independent Test).
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

**Checkpoint**: Customer half of the billing lifecycle is complete and independently testable.

---

## Phase 7: User Story 6 - Billing Admin reviews and decides on payment submissions (Priority: P1)

**Goal**: A Billing Admin reviews and approves/rejects/requests-more-info on payment submissions, the only
mechanism that activates a subscription at launch (FR-034–FR-036).

**Independent Test**: Seed a "Pending Review" submission and have a Billing Admin approve, reject, or request
more information on it, independent of re-running Story 5's customer flow.

### Tests for User Story 6

- [ ] T064 [P] [US6] Role-matrix authorization test: every `/internal/billing/*` endpoint against
  unauthenticated, Workspace Owner (own tenant), Workspace Owner (foreign tenant), Billing Admin, and Support —
  each run twice (UI-shaped call and raw HTTP replay) — in
  `backend/api/test/integration/billing-admin-authorization.integration-spec.ts`
  - **Dependencies**: T018
  - **Acceptance Criteria**: Matches FR-004 and plan.md's Authorization test strategy exactly; no customer
    identity can ever self-approve (structural, not just configured).
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T065 [P] [US6] Integration test: two concurrent approve calls on the same submission produce exactly one
  activation and one `billing.subscription.activated` event; the second call receives 409, in
  `backend/api/test/integration/billing-approval-idempotency.integration-spec.ts`
  - **Dependencies**: T012, T011
  - **Acceptance Criteria**: Matches Acceptance Scenario 6.6 and plan.md's Idempotency "Payment decisions"
    test strategy.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T066 [P] [US6] Integration test: the FR-009 field list is asserted verbatim (all named fields present
  and non-null where required) on every `billing.payment_submission.decided` and
  `billing.subscription.activated` event, in
  `backend/api/test/integration/billing-audit-completeness.integration-spec.ts`
  - **Dependencies**: T019
  - **Acceptance Criteria**: Direct test for SC-007; matches Acceptance Scenario 6.5.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T067 [P] [US6] Integration test: repeated request-more-info cycles on the same billing period each
  appear individually in `status_history`, and the customer-visible view always shows the latest request, in
  `backend/api/test/integration/billing-more-info-cycles.integration-spec.ts`
  - **Dependencies**: T012
  - **Acceptance Criteria**: Matches Acceptance Scenario 6.4 and the Edge Case for repeated more-info cycles.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

### Implementation for User Story 6

- [ ] T068 [US6] Implement `GET /internal/billing/review-queue` (all PendingReview/MoreInfoRequested
  submissions across tenants, Billing Admin role only) in
  `backend/api/src/modules/billing-admin/billing-admin.controller.ts`
  - **Dependencies**: T012, T018
  - **Acceptance Criteria**: Matches Acceptance Scenario 6.1; every required field (customer, tenant, plan,
    billing period, amount, currency, bank reference, proof document) is present.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T069 [US6] Implement `POST /internal/billing/payment-submissions/{id}/approve` (atomic subscription
  activation/renewal in the same transaction, duplicate-activation 409, emits
  `billing.payment_submission.decided` + `billing.subscription.activated` with the full FR-009 field set) in
  `backend/api/src/modules/billing-admin/billing-admin.service.ts`
  - **Dependencies**: T068, T019
  - **Acceptance Criteria**: Matches Acceptance Scenarios 6.2/6.5/6.6.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T070 [US6] Implement `POST /internal/billing/payment-submissions/{id}/reject` and
  `.../request-more-info` (customer notification via the `notification.billing_decision` queue, appends to
  `status_history`) in `backend/api/src/modules/billing-admin/billing-admin.service.ts`
  - **Dependencies**: T068, T021
  - **Acceptance Criteria**: Matches Acceptance Scenarios 6.3/6.4.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T071 [P] [US6] Build the Billing Admin review-queue UI (internal route group, submission detail with
  proof download via presigned URL, approve/reject/request-more-info actions) in
  `frontend/src/app/(internal)/billing-review/`
  - **Dependencies**: T024, T068, T069, T070
  - **Acceptance Criteria**: Matches Acceptance Scenarios 6.1–6.4; achievable within SC-008's 5-minute active
    review-time target.
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

**Checkpoint**: Stories 1, 2, 3, 5, and 6 together deliver the complete P1 signup-to-billed-subscription path —
the minimum shippable core.

---

## Phase 8: User Story 4 - Select modules and features for the workspace (Priority: P2)

**Goal**: The Workspace Owner selects modules/features constrained by the active plan's entitlements
(FR-029/FR-030).

**Independent Test**: Against a company that finished setup, present the module list, attempt to select a
module outside plan entitlements, confirm the system blocks/upsells rather than silently enabling it.

### Tests for User Story 4

- [ ] T072 [P] [US4] Contract test: `GET /modules` and `PUT /modules/selection` against
  `contracts/openapi.yaml` in `backend/api/test/contract/modules.contract-spec.ts`
  - **Dependencies**: T022
  - **Acceptance Criteria**: 200/403 response codes each exercised and schema-conformant.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T073 [P] [US4] Integration test: enabling a non-entitled feature key is rejected server-side both via
  the documented UI-call shape and a raw HTTP replay in
  `backend/api/test/integration/module-selection-entitlement.integration-spec.ts`
  - **Dependencies**: T010
  - **Acceptance Criteria**: Matches Acceptance Scenario 4.3 and the Edge Case "via a direct request rather
    than the UI" (FR-006).
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T074 [P] [US4] Playwright EN/AR-RTL + axe test: module list with plan-included/upgrade indicators and
  selection-save flow in `frontend/tests/e2e/us4-module-selection.spec.ts`
  - **Dependencies**: T023
  - **Acceptance Criteria**: Matches Acceptance Scenarios 4.1/4.2/4.3.
  - **Roles**: Primary: Codex · Backup: Claude · Reviewer: Gemini

### Implementation for User Story 4

- [ ] T075 [US4] Implement the `kemfai_module_selection` Odoo addon (per-tenant `ModuleSelection` cache:
  feature_key, enabled, updated_at/by) in `backend/addons/kemfai_module_selection/models/`
  - **Dependencies**: T047
  - **Acceptance Criteria**: Matches data-model.md's ModuleSelection table verbatim.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T076 [US4] Implement `GET /modules` (plan-inclusion/upgrade indicators sourced from
  `EntitlementsService`) and `PUT /modules/selection` (server-side entitlement enforcement, immediate
  reflection, emits `modules.selection.changed`) in
  `backend/api/src/modules/module-selection/module-selection.controller.ts` and `.service.ts`
  - **Dependencies**: T010, T026, T075, T100, T101
  - **Acceptance Criteria**: Matches Acceptance Scenarios 4.1/4.2/4.3/4.4; reads only `EntitlementsService`
    (T010), never a raw plan-name check; the module-selection surface is gated by `FeatureFlagGuard` (T100) so
    it can be hidden platform-wide until intentionally turned on, per Constitution Principle VI (C1 remediation
    — see analysis.md); `TrialWindowGuard` (T101) is also applied to this endpoint and denies both the
    documented UI-shaped call and a raw HTTP replay identically once the trial window has elapsed with
    `autoRestrictUnpaid` resolved true and no `Active` Subscription — one of the three FR-030a onboarding paths
    (company setup T054, module selection, checklist T082) that must each carry this guard explicitly (Round 2
    remediation — see analysis.md).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T077 [P] [US4] Build the module/feature selection UI (included vs. upgrade-required indicators, blocked-
  selection upsell messaging) in `frontend/src/app/(onboarding)/modules/page.tsx`
  - **Dependencies**: T024, T076
  - **Acceptance Criteria**: Matches Acceptance Scenarios 4.1–4.4; reflects immediately in navigation/checklist
    per Acceptance Scenario 4.2; when `FeatureFlag.enabled=false` for the modules feature, this route and any
    navigation entry pointing to it are absent from the rendered UI entirely (no disabled/greyed-out link, no
    reachable-but-blocked page) — matching data-model.md's "hidden entirely" requirement for `FeatureFlagGuard`
    (T100), not merely a server-side 403 (Round 2 remediation — see analysis.md).
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

**Checkpoint**: Module selection is live, entitlement-gated, and audited.

---

## Phase 9: User Story 7 - Track onboarding progress via checklist (Priority: P2)

**Goal**: A persistent, live-computed onboarding checklist tracks customer/bank/product/first-invoice readiness
(FR-037/FR-038).

**Independent Test**: Manipulate underlying readiness signals and confirm the checklist reflects each state
change without requiring later invoicing slices.

### Tests for User Story 7

- [ ] T078 [P] [US7] Contract test: `GET /onboarding/checklist` against `contracts/openapi.yaml` in
  `backend/api/test/contract/checklist.contract-spec.ts`
  - **Dependencies**: T022
  - **Acceptance Criteria**: Response matches `ChecklistState` schema exactly, including
    `gatedOnSubscriptionActivation`.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T079 [P] [US7] Integration test: create then delete each underlying record (customer/bank/product) and
  assert the checklist item flips back to incomplete without any direct checklist mutation, in
  `backend/api/test/integration/checklist-liveness.integration-spec.ts`
  - **Dependencies**: T026
  - **Acceptance Criteria**: Direct test for SC-010 and the Edge Case on deleted underlying records.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T080 [P] [US7] Playwright EN/AR-RTL + axe test: checklist empty state, item completion without a manual
  reload, and activation-gated first-invoice messaging in `frontend/tests/e2e/us7-checklist.spec.ts`
  - **Dependencies**: T023
  - **Acceptance Criteria**: Matches Acceptance Scenarios 7.1–7.4.
  - **Roles**: Primary: Codex · Backup: Claude · Reviewer: Gemini

### Implementation for User Story 7

- [ ] T081 [US7] Implement the `kemfai_onboarding_checklist` Odoo addon's computed views
  (`customer_added`, `bank_added`, `product_added`, `first_invoice_ready`) over `res.partner` /
  `res.partner.bank`/`account.journal` / `product.product`, with no independently-stored "done" flag, in
  `backend/addons/kemfai_onboarding_checklist/models/`
  - **Dependencies**: T047
  - **Acceptance Criteria**: Matches the Key Entities definition ("derived... rather than stored") and
    SC-010.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T082 [US7] Implement `GET /onboarding/checklist` (live-computed via Odoo JSON-RPC,
  `gatedOnSubscriptionActivation` sourced from `Subscription.status`) in
  `backend/api/src/modules/checklist/checklist.controller.ts` and `.service.ts`
  - **Dependencies**: T026, T081, T011, T100, T101
  - **Acceptance Criteria**: Matches Acceptance Scenarios 7.1–7.4 and FR-038's distinct activation-gate
    indication; the checklist surface is gated by `FeatureFlagGuard` (T100) so it can be hidden platform-wide
    until intentionally turned on, per Constitution Principle VI (C1 remediation — see analysis.md);
    `TrialWindowGuard` (T101) is also applied to this endpoint and denies both the documented UI-shaped call and
    a raw HTTP replay identically once the trial window has elapsed with `autoRestrictUnpaid` resolved true and
    no `Active` Subscription — one of the three FR-030a onboarding paths (company setup T054, module selection
    T076, checklist) that must each carry this guard explicitly (Round 2 remediation — see analysis.md).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T083 [P] [US7] Build the onboarding checklist UI (four items with direct links, empty state, activation-
  gate indicator distinct from setup-readiness) in `frontend/src/app/(onboarding)/checklist/page.tsx`
  - **Dependencies**: T024, T082
  - **Acceptance Criteria**: Matches Acceptance Scenarios 7.1–7.4; updates without a page reload initiated
    solely for that purpose (Acceptance Scenario 7.2); when `FeatureFlag.enabled=false` for the checklist
    feature, this route and any navigation entry pointing to it are absent from the rendered UI entirely (no
    disabled/greyed-out link, no reachable-but-blocked page) — matching data-model.md's "hidden entirely"
    requirement for `FeatureFlagGuard` (T100), not merely a server-side 403 (Round 2 remediation — see
    analysis.md).
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

**Checkpoint**: All setup/billing flows now have a live guidance layer on top of them.

---

## Phase 10: User Story 8 - Grant, use, and audit time-limited customer support access (Priority: P3)

**Goal**: A customer grants time-limited support access; the grant auto-expires; every access event is logged
(FR-039–FR-041).

**Independent Test**: Issue a grant with an expiry, access within the window as a support-role account, confirm
refusal after expiry, and confirm every action is audit-logged — independent of any other onboarding story.

### Tests for User Story 8

- [ ] T084 [P] [US8] Contract test: `GET`/`POST /support-access/grants` and
  `POST /support-access/grants/{id}/revoke` against `contracts/openapi.yaml` in
  `backend/api/test/contract/support-access.contract-spec.ts`
  - **Dependencies**: T022
  - **Acceptance Criteria**: 200/201 response codes each exercised and schema-conformant.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T085 [P] [US8] Integration test: an expired or revoked grant denies access and logs the attempt
  (`SupportAccessUsage.was_denied=true`) for every attempt, in
  `backend/api/test/integration/support-access-denial.integration-spec.ts`
  - **Dependencies**: T013
  - **Acceptance Criteria**: Matches Acceptance Scenario 8.3 and FR-041.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T086 [P] [US8] Integration test: running the expiry sweep twice in the same tick window does not
  double-flip or double-audit a grant, in
  `backend/api/test/integration/support-access-sweep-idempotency.integration-spec.ts`
  - **Dependencies**: T013
  - **Acceptance Criteria**: Matches plan.md's Idempotency "Support-access sweep" test strategy and
    research.md §8.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T087 [P] [US8] Playwright EN/AR-RTL + axe test: grant creation (mandatory expiry), history view, and
  revoke action in `frontend/tests/e2e/us8-support-access.spec.ts`
  - **Dependencies**: T023
  - **Acceptance Criteria**: Matches Acceptance Scenarios 8.1/8.4/8.5.
  - **Roles**: Primary: Codex · Backup: Claude · Reviewer: Gemini

### Implementation for User Story 8

- [ ] T088 [US8] Implement `GET`/`POST /support-access/grants` (mandatory expiry, emits
  `support_access.grant.created`) and `POST /support-access/grants/{id}/revoke` (immediate, emits
  `support_access.grant.revoked`) in `backend/api/src/modules/support-access/support-access.controller.ts` and
  `.service.ts`
  - **Dependencies**: T013, T017, T100
  - **Acceptance Criteria**: Matches Acceptance Scenarios 8.1/8.4; only the Workspace Owner may create/revoke
    for their own tenant; the support-access surface is gated by `FeatureFlagGuard` (T100) so it can be hidden
    platform-wide until intentionally turned on, per Constitution Principle VI (C1 remediation — see
    analysis.md).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T089 [US8] Implement support-access read-time enforcement (checks `expires_at`/`revoked_at` on every
  access, logs `SupportAccessUsage` including denials, emits `support_access.grant.used`/`.denied`) in
  `backend/api/src/common/guards/support-access.guard.ts`
  - **Dependencies**: T088
  - **Acceptance Criteria**: Matches Acceptance Scenarios 8.2/8.3 and FR-005/FR-041.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T090 [US8] Implement the `support_access.expiry_sweep` BullMQ scheduled job (every 30 seconds, flips
  newly-expired grants, emits `support_access.grant.expired`) in
  `backend/api/src/integrations/provisioning/support-access-sweep.processor.ts`
  - **Dependencies**: T021, T088
  - **Acceptance Criteria**: Matches SC-009 (inaccessible within 1 minute of expiry, zero manual revocation)
    and research.md §8's rationale for proactive sweeping over lazy-only checks.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T091 [P] [US8] Build the support-access grant creation form, active-grant status, and history view
  (every past grant/usage/revocation visible) in `frontend/src/app/(onboarding)/support-access/page.tsx`
  - **Dependencies**: T024, T088
  - **Acceptance Criteria**: Matches Acceptance Scenarios 8.1/8.4/8.5; when `FeatureFlag.enabled=false` for the
    support-access feature, this route and any navigation entry pointing to it are absent from the rendered UI
    entirely (no disabled/greyed-out link, no reachable-but-blocked page) — matching data-model.md's "hidden
    entirely" requirement for `FeatureFlagGuard` (T100), not merely a server-side 403 (Round 2 remediation — see
    analysis.md).
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

**Checkpoint**: All 8 user stories are independently functional — full Slice 1 scope delivered.

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Cross-story audit read-surface, full-surface test sweeps, and release hardening.

- [ ] T092 [P] Implement `GET /internal/audit-events` (read-only, filterable by `tenantId`/`action`, internal
  auditor role) in `backend/api/src/modules/audit/audit.controller.ts`
  - **Dependencies**: T019, T018
  - **Acceptance Criteria**: Response matches `AuditEventView` schema; write attempts against this endpoint
    are impossible by design (read-only route).
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T093 [P] Source-linkage cross-cutting test: every `AuditEvent` written across all prior test suites
  resolves `subject_type`/`subject_id` to a real, currently-queryable record or an inspectable historical
  `PaymentSubmission.status_history`, in `backend/api/test/integration/audit-source-linkage.integration-spec.ts`
  - **Dependencies**: T019, T092
  - **Acceptance Criteria**: Matches Constitution Principle II/P-03 spirit and FR-009; no audit event
    references an untraceable subject.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T094 [P] Empty/error/loading-state coverage sweep across FR-010/FR-011/FR-012 (plan list, module list,
  checklist, support-access history empty states; every listed error state) in
  `frontend/tests/e2e/empty-error-loading-states.spec.ts`
  - **Dependencies**: T036, T077, T083, T091
  - **Acceptance Criteria**: Every state enumerated in FR-010/FR-011/FR-012 has at least one passing assertion
    that it renders under its triggering condition.
  - **Roles**: Primary: Codex · Backup: Claude · Reviewer: Gemini

- [ ] T095 [P] Full-surface EN/AR-RTL + axe accessibility sweep across every screen listed in FR-013, in
  `frontend/tests/e2e/full-surface-a11y-rtl.spec.ts`
  - **Dependencies**: T030, T043, T052, T060, T071, T074, T080, T087
  - **Acceptance Criteria**: Matches SC-005; a failing axe violation or LTR-only rendering in Arabic fails the
    build, not just a warning.
  - **Roles**: Primary: Codex · Backup: Claude · Reviewer: Gemini

- [ ] T096 Security hardening pass: presigned URL expiry tuning, Keycloak service-account credential scoping,
  and rate limiting on `/accounts/signup` and `/accounts/verify-email`, in `backend/api/src/common/` and
  `backend/api/src/integrations/minio/`
  - **Dependencies**: T025, T032, T033
  - **Acceptance Criteria**: Presigned URLs expire within a documented short window; signup/verify-email
    endpoints reject bursts beyond a documented rate limit with a localized 429.
  - **Roles**: Primary: GLM · Backup: Claude · Reviewer: Codex

- [ ] T097 [P] Documentation: reconcile any implementation-time deviations discovered during build back into
  `specs/001-saas-onboarding-shell/quickstart.md` and, if a locked baseline item is affected, flag it for Owner
  approval per `docs/GATE0_DECISIONS.md`
  - **Dependencies**: T001–T096, T099–T107 (post-implementation — the full set of Setup/Foundational/User-Story
    tasks including the T099–T107 remediation additions; previously this omitted T099–T107 entirely, letting
    documentation reconciliation complete before those tasks existed — fixed in Round 2 remediation; see
    analysis.md)
  - **Acceptance Criteria**: quickstart.md accurately describes the as-built system with zero stale steps,
    including the feature-flag (T099/T100), trial-window (T101/T102), locale-persistence (T103/T104), and
    company-settings (T105–T107) mechanics; any locked-baseline deviation is explicitly flagged, not silently
    merged (Constitution Governance).
  - **Roles**: Primary: Claude · Backup: Gemini · Reviewer: Codex

- [ ] T098 Run the full `quickstart.md` validation end-to-end (all 8 story walkthroughs, once EN/LTR and once
  AR/RTL) and record pass/fail results
  - **Dependencies**: T097, T108, T109, T110, T111, T112 (previously only T097, which let this task claim a
    fully green automated suite before the CI wiring and full-surface sweeps it depends on even existed — fixed
    in Round 2 remediation; see analysis.md)
  - **Acceptance Criteria**: All 8 walkthroughs pass in both locales; all four automated verification entry
    points (`test:contract`, `test:integration`, `playwright test`, Odoo addon tests), as wired into CI by T108,
    are green; the T109 Odoo-exposure sweep, T110 colour-independence sweep, T111 trial-window enforcement test,
    and T112 feature-flag gating test (HTTP and rendered-UI) all pass — the slice is considered validated per
    quickstart.md's closing statement only once every one of these is green, not merely the pre-remediation
    T001–T096 suite.
  - **Roles**: Primary: Gemini · Backup: Claude · Reviewer: Codex

- [ ] T108 [P] Wire the NestJS Jest contract/integration suites (`npm run test:contract`,
  `npm run test:integration` in `backend/api`), the Playwright e2e/a11y suites (`npx playwright test` in
  `frontend`), and the Odoo addon Python tests (`odoo-bin --test-enable` against each `kemfai_*` addon) into
  `.github/workflows/ci.yml`, replacing the `accounting-invariants` job's literal `echo` placeholder with real
  invocations, in `.github/workflows/ci.yml` (G2 remediation — see analysis.md)
  - **Dependencies**: T001, T002, T005
  - **Acceptance Criteria**: `ci.yml` runs all four suites on every PR to `main`/`develop`; the
    `accounting-invariants` job no longer contains a literal `echo` placeholder; a failing test in any of the
    four suites blocks merge, making the Constitution's green-CI merge gate meaningful for this feature rather
    than only linting frontend and best-effort Python pytest.
  - **Roles**: Primary: GLM · Backup: Codex · Reviewer: Gemini

- [ ] T109 [P] Full-surface Odoo-exposure sweep: assert no native Odoo terminology, URLs, or raw Odoo payloads
  appear in any HTTP response body or rendered DOM across **every** customer-facing screen/endpoint delivered by
  this feature — public plan list (T036), signup (T037), verify-email (T038), MFA enrollment (T039),
  provisioning status (T048), the company setup wizard (T052/T056), company settings (T107), billing (T063),
  module selection (T077), the onboarding checklist (T083), support access (T091), and the Billing Admin review
  queue (T071) — not a subset, in `frontend/tests/e2e/full-surface-odoo-exposure-sweep.spec.ts` and
  `backend/api/test/integration/no-odoo-exposure.integration-spec.ts` (G1/F6 remediation — see analysis.md;
  FR-013, FR-042, SC-011; scope widened to public/auth, provisioning status, and company settings in Round 2
  remediation — see analysis.md)
  - **Dependencies**: T036, T037, T038, T039, T048, T052, T063, T071, T077, T083, T091, T107
  - **Acceptance Criteria**: Scans rendered DOM and HTTP response bodies for Odoo-specific terms (e.g.
    `res.company`, `res.partner`, `/web/`, `xmlrpc`, `jsonrpc`, `kemfai_tenant_` database names) across every
    screen enumerated in FR-013 plus the provisioning-status screen (T048) and the company-settings screen
    (T107, added after FR-013 was written but customer-facing) — zero instances found, directly closing
    SC-011's "across acceptance testing" claim across the feature's full surface, not a subset of it.
  - **Roles**: Primary: Codex · Backup: Gemini · Reviewer: Claude

- [ ] T110 [P] Explicit colour-independent status-label test: for **every** status/warning/error indicator in
  scope — the billing lifecycle (Pending Review, Approved, Rejected, Request More Information), support-access
  grants (expired/active/revoked), tenant provisioning (Pending/Creating/Ready/Failed), signup/verification
  errors (malformed email, weak password, duplicate email, expired/invalid/reused verification link, T038),
  setup-wizard validation and configuration-gap errors (T056), payment-proof upload errors — unsupported
  type/size/unreadable (T063), module-selection blocked/upgrade-required indicators (T077), and the checklist's
  activation-gated indicator distinct from setup-readiness (T083) — assert a text/label is present and
  independently legible without relying on any colour cue, in
  `frontend/tests/e2e/status-text-label-not-colour-only.spec.ts` (U1/F7 remediation — see analysis.md; FR-012,
  FR-015; scope widened from the lifecycle-state subset to the full FR-012/FR-015 surface in Round 2 remediation
  — see analysis.md)
  - **Dependencies**: T037, T038, T048, T056, T063, T071, T077, T083, T087
  - **Acceptance Criteria**: Explicitly distinct from the axe accessibility checks (T030/T043/T052/T060/T071/
    T074/T080/T087/T095), since axe does not detect colour-only encoding of state; every status/warning/error
    indicator enumerated in FR-012 and FR-015 across the full feature surface (not only the billing/support-
    access/provisioning lifecycle states) has a passing assertion of an independent text label.
  - **Roles**: Primary: Codex · Backup: Claude · Reviewer: Gemini

- [ ] T111 [P] Cross-cutting integration test: trial-window enforcement — a tenant past `trialWindowDays` with
  `autoRestrictUnpaid` resolved true and a non-`Active` Subscription is denied onboarding-scoped access on ALL
  THREE FR-030a paths (`PUT /companies/current/setup` T054, `PUT /modules/selection` T076,
  `GET /onboarding/checklist` T082), each exercised through BOTH the documented UI-shaped call and a raw HTTP
  replay (mirroring the FR-006 pattern used for T064/T073); an `Active` Subscription or a plan resolving
  `autoRestrictUnpaid=false` bypasses restriction on all three; running `trial.expiry_sweep` twice in the same
  tick window does not double-audit a tenant, in
  `backend/api/test/integration/trial-window-enforcement.integration-spec.ts` (F2 remediation — see analysis.md;
  three-path + dual-call-shape coverage added in Round 2 remediation — see analysis.md)
  - **Dependencies**: T054, T076, T082, T101, T102
  - **Acceptance Criteria**: Matches FR-030a and plan.md's Idempotency "Trial-window sweep" test strategy;
    mirrors T086's support-access sweep idempotency test exactly; asserts six distinct denial cases (3 paths ×
    2 call shapes) plus the two bypass cases and the sweep-idempotency case — no path is left implicitly
    covered by inference from another.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

- [ ] T112 [P] Cross-cutting test: `FeatureFlagGuard` denies access to a flagged-off module identically via the
  documented UI-shaped call and a raw HTTP replay, and no gated route bypasses the guard — AND, separately, a
  rendered-UI check that a flagged-off surface is absent from the DOM/navigation (not merely guarded at the API),
  in `backend/api/test/integration/feature-flag-gating.integration-spec.ts` (HTTP-level) and
  `frontend/tests/e2e/feature-flag-ui-gating.spec.ts` (rendered-UI level) (C1 remediation — see analysis.md;
  Constitution Principle VI; rendered-UI coverage added in Round 2 remediation — see analysis.md)
  - **Dependencies**: T099, T100, T077, T083, T091
  - **Acceptance Criteria**: Matches plan.md's Test Strategy "Feature-flag/module-gating" coverage; the HTTP
    spec runs twice per gated endpoint (UI-shaped and raw HTTP replay), both denied identically, mirroring the
    FR-006 pattern used for authorization tests (T064); the Playwright spec additionally asserts, for each of
    T077 (modules), T083 (checklist), and T091 (support access), that with the corresponding `FeatureFlag`
    disabled the route is unreachable via navigation and the rendered DOM contains no trace of the gated screen
    — this is a distinct assertion from the HTTP-only guard-denial check and is the direct fix for the gap where
    a flagged-off feature could still be discoverable/rendered in the UI even while its API calls were denied.
  - **Roles**: Primary: Codex · Backup: GLM · Reviewer: Gemini

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories.
- **User Stories (Phases 3–10)**: All depend on Foundational completion. Within that constraint:
  - **US2 depends on US1** (provisioning triggers on email verification — T044 needs T033's verified-account
    event path to exist in practice, though it is technically wired to the `account.email_verified` signal).
  - **US3 depends on US2** (wizard operates inside an already-provisioned tenant/company — T053 needs T047).
  - **US5 depends on US2** (billing reads the `Subscription` row created during provisioning — T061 needs T044).
  - **US6 depends on US5** (review queue operates on `PaymentSubmission` rows US5 creates — T068 needs T012,
    exercised by T062), though US6's own tests may seed data directly per its Independent Test.
  - **US4 and US7 (P2)** depend on Foundational + US2/US3 (module selection needs a set-up company context;
    checklist needs a provisioned tenant) but are independent of each other and of US5/US6.
  - **US8 (P3)** depends only on Foundational + US2 (a Tenant must exist to grant access against).
- **Polish (Phase 11)**: Depends on all desired user stories being complete.

### Within Each User Story

- Tests are written first and MUST fail before implementation (Constitution Quality Gates).
- Odoo addon/entity work before NestJS service work before frontend UI work.
- Story complete (checkpoint) before moving to the next priority tier.

### Parallel Opportunities

- All `[P]`-marked Setup tasks (T002–T005) run in parallel once T001 exists where noted.
- Within Foundational, entity/migration tasks T007–T014 run in parallel (different files); guards/interceptors
  T017–T020 run in parallel once their entity dependencies land.
- Once Foundational completes, US1, and — after US2 lands — US4/US7/US8 can be staffed in parallel by different
  Primary owners (Claude for frontend-heavy stories, GLM for backend-heavy stories) without cross-story file
  conflicts.
- All test tasks within a story phase (contract/integration/Playwright) run in parallel with each other.

---

## Parallel Example: User Story 1

```bash
# Tests (parallel — different files):
Task: "Contract test for accounts endpoints in backend/api/test/contract/accounts.contract-spec.ts"
Task: "Integration test for duplicate/unverified signup in backend/api/test/integration/accounts-signup.integration-spec.ts"
Task: "Integration test for verification-link supersession in backend/api/test/integration/accounts-verification.integration-spec.ts"
Task: "Playwright EN/AR-RTL + a11y test in frontend/tests/e2e/us1-signup.spec.ts"

# Frontend screens (parallel — different files, after their backend endpoints land):
Task: "Public plan-selection page in frontend/src/app/(public)/plans/page.tsx"
Task: "Signup form page in frontend/src/app/(auth)/signup/page.tsx"
Task: "Verify-email screen in frontend/src/app/(auth)/verify/page.tsx"
Task: "MFA enrollment screen in frontend/src/app/(auth)/mfa/page.tsx"
```

---

## Implementation Strategy

### MVP First (User Stories 1, 2, 3, 5, 6 — all P1)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories).
3. Complete Phases 3–7 in order: US1 → US2 → US3 → US5 → US6.
4. **STOP and VALIDATE**: run the quickstart.md walkthroughs for Stories 1–6 in both EN and AR.
5. This is the minimum shippable slice: a customer can sign up, get an isolated workspace, configure their
   company, and get billed/activated through a fully audited manual bank-transfer flow.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 → US2 → US3 → US5 → US6 → validate independently at each checkpoint → this is the P1 MVP.
3. Add US4 (module selection) → validate independently.
4. Add US7 (onboarding checklist) → validate independently.
5. Add US8 (support access) → validate independently.
6. Polish phase → full quickstart.md validation, both locales, all four automated entry points green.

### Parallel Team Strategy

With the AGENTS.md roster (Claude, GLM, Codex, Gemini):

1. Claude and GLM complete Setup + Foundational together (frontend/backend split as marked per task).
2. Once Foundational is done:
   - GLM drives backend/Odoo implementation tasks story-by-story (P1 order first).
   - Claude drives frontend implementation tasks in the same story order, one story behind GLM's backend
     completion (each screen depends on its endpoint).
   - Codex writes and runs the test tasks for each story as GLM's backend tasks land (tests-first where the
     story's test tasks are listed before implementation).
   - Gemini reviews test tasks for cross-consistency and performs the Polish-phase full-surface sweeps
     alongside Codex.
3. No task's Reviewer is ever its own Primary (Constitution "No self-review"; AGENTS.md rule 6).

---

## Notes

- `[P]` tasks touch different files with no incomplete-task dependency.
- `[Story]` labels map every Phase 3–10 task to its user story for traceability back to spec.md.
- FR-030a's trial-window/auto-restriction values are config rows from T009/T010/T015 onward — no task in this
  file may introduce a hard-coded plan-name or trial-day constant; T010's acceptance criteria makes this
  independently checkable.
- Commit after each task or logical group; verify each story's tests fail before its implementation tasks land.
- Stop at any checkpoint to validate a story independently before proceeding to the next.
- **Remediation additions (T099–T113)**: Added during cross-artifact analysis remediation (see
  `specs/001-saas-onboarding-shell/analysis.md` for the full finding-by-finding record, including the "Round 2
  remediation" section covering 7 structural issues Codex found in the first remediation pass). T099–T102 and
  T113 are Foundational (Phase 2) and block the same way T006–T026 do. T103/T104 (US1), T105–T107 (US3) slot
  into their story phases. T108–T112 are Polish-phase and depend on the story screens/endpoints they sweep or
  test, and T097/T098 now correctly depend on the full T099–T112 set (Round 2 remediation). Existing Task IDs
  T001–T098 are unchanged; nothing was renumbered.
