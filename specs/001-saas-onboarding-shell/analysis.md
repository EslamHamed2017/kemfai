# Remediation Record: KEMFAI Slice 1 — SaaS Onboarding Shell

**Purpose**: Records how each finding from the two overlapping `/speckit-analyze` passes (treated as one
consolidated list) was resolved, prior to `/speckit-implement` starting. All edits below were made directly to
spec artifacts (spec.md, plan.md, data-model.md, tasks.md, contracts/events.md) — no application code was
written. Task IDs T001–T098 were left untouched; all new work was appended as T099–T112, inserted into their
logically correct phase sections.

## C1 (CRITICAL) — Constitution Principle VI feature-flag gap

**Finding**: Constitution Principle VI requires incomplete modules to sit behind feature flags; no task
implemented any flag/module-gating mechanism, and plan.md's Constitution Check marked Principle VI PASS without
addressing the clause at all.

**Resolution**:
- Added a `FeatureFlag` entity to data-model.md (control-plane, alongside Plan/Feature/PlanFeatureEntitlement),
  read exclusively through the same `EntitlementsService` as FR-030a — never a second config path.
- Added T099 (Foundational): `FeatureFlag` migration/entity + `EntitlementsService` extension.
- Added T100 (Foundational): `FeatureFlagGuard`, applied identically to UI and raw HTTP paths.
- Referenced T100 explicitly in the acceptance criteria of T076 (US4 module selection), T082 (US7 checklist),
  and T088 (US8 support access) — the three stories least mature relative to the P1 MVP core.
- Added T112 (Polish): cross-cutting test that the guard denies UI-shaped and raw-HTTP calls identically.
- Corrected plan.md's Constitution Check table (Principle VI row) and Post-Design Re-check section to honestly
  describe the mechanism and point back to this record, instead of an unaddressed PASS.

## F2 (HIGH) — FR-030a trial window not actually enforced

**Finding**: Only config data (PlanSetting/EntitlementDefault) and a read-only `GET /entitlements/me` existed;
nothing enforced the trial window or applied `autoRestrictUnpaid`.

**Resolution**:
- Added T101 (Foundational): `TrialWindowGuard` — computes elapsed time since `Tenant.ready_at` against the
  resolved `trialWindowDays`, restricting onboarding-scoped access only when `autoRestrictUnpaid` resolves true
  and the tenant's Subscription is not `Active`. All values read via `EntitlementsService` only.
- Added T102 (Foundational): `trial.expiry_sweep` BullMQ job, mirroring `support_access.expiry_sweep` (T090) —
  proactively emits `tenant.trial.restricted` for observability; live enforcement is always the guard's job.
- Added T111 (Polish): integration test covering Active-subscription bypass, `autoRestrictUnpaid=false` bypass,
  and sweep double-run idempotency (mirrors T086 exactly).
- Documented the mechanism in data-model.md (new "Trial-window enforcement" note under Subscription) and added
  `tenant.trial.restricted` (audit event) and `trial.expiry_sweep` (background job) to contracts/events.md.
- Added a "Trial-window sweep" bullet to plan.md's Test Strategy Idempotency section, mirroring the existing
  support-access sweep bullet.

## I1 (HIGH) — PlanSetting.auto_restrict_unpaid self-contradiction

**Finding**: `auto_restrict_unpaid` was documented as both "default true" and "nullable meaning use default,"
and `EntitlementDefault` had no fallback field for it.

**Resolution**:
- data-model.md: `PlanSetting.auto_restrict_unpaid` is now nullable with no in-column default, meaning "use
  default" — identical shape to `trial_window_days`. Added `EntitlementDefault.default_auto_restrict_unpaid`
  (bool, seeded `true`), read only when the per-plan column is null — mirroring the trial-window fallback
  exactly.
- tasks.md T009's acceptance criteria updated to require the mirrored nullable/fallback shape on both fields
  and the new seeded default column.
- tasks.md T010's acceptance criteria updated to require both fallback paths (trial window and auto-restrict)
  be implemented and independently testable.

## F1 (HIGH) — T044 never creates the tenant MinIO bucket

**Finding**: T040/T041 asserted a bucket exists after provisioning and T062 (proof upload) depends on it, but
no task actually called `createTenantBucket`.

**Resolution**:
- tasks.md T044 rewritten to explicitly call `createTenantBucket(tenantId)` (T025) and set
  `Tenant.minio_bucket`, sequenced before Odoo DB creation, per plan.md's Storage section.
- data-model.md's Tenant entity gained a "Provisioning order" note making this sequencing an explicit,
  checkable constraint rather than implicit narrative.

## F3 (HIGH) — FR-028 post-completion editing has no distinct implementation

**Finding**: FR-028 requires setup-wizard values be editable afterward through company settings, not only by
re-running the wizard; no task built this distinct surface.

**Resolution**:
- Added T105 (US3 test): contract test for `GET`/`PUT /companies/current/settings`.
- Added T106 (US3 impl): the endpoint itself, reachable only once `Company.setup_complete=true`, emitting a new
  `company.settings.updated` audit event (added to contracts/events.md) distinct from `company.setup.completed`.
- Added T107 (US3 impl): the company-settings screen, independent of the setup-wizard route.
- data-model.md's Company entity gained a "Post-completion editing" note cross-referencing both surfaces.

## G2 (HIGH) — CI does not run this feature's test suites

**Finding**: `.github/workflows/ci.yml` only lints frontend and best-effort-runs Python pytest; its
`accounting-invariants` job is a literal `echo` placeholder, making the constitutional green-CI merge gate
meaningless for this feature.

**Resolution**:
- Added T108 (Polish): wires the NestJS Jest contract/integration suites, the Playwright e2e/a11y suites, and
  the Odoo addon Python tests into `ci.yml`, replacing the placeholder `echo` job.
- This is a tasks.md task only — `ci.yml` itself is application/infra config, not a spec artifact, so it was
  not edited directly per this remediation's scope (spec.md/plan.md/data-model.md/tasks.md/contracts/events.md
  only); T108 will make the edit during implementation.

## G1/F6 (HIGH) — Odoo-exposure check scoped only to the US3 wizard

**Finding**: FR-042/SC-011 require zero native-Odoo exposure across ALL customer-facing screens, but only T052
(US3 wizard) checked it.

**Resolution**:
- Added T109 (Polish): full-surface sweep across billing (T063), checklist (T083), module selection (T077),
  support access (T091), and the Billing Admin review queue (T071), in addition to the wizard.
- Added a corresponding bullet to plan.md's Test Strategy explaining why T052 alone under-covers SC-011's
  "across acceptance testing" claim.

## F5 (MEDIUM) — T044 only committed to the `.failed` lifecycle event

**Finding**: contracts/events.md requires `tenant.provisioning.attempted`/`.succeeded` in addition to `.failed`,
but T044's description only named `.failed`.

**Resolution**: tasks.md T044 rewritten to require all three events at their respective points in the
processor (attempted at start, succeeded on Ready, failed on failure) — contracts/events.md's catalog already
listed all three; only T044's task description was out of sync.

## U2 (MEDIUM) — FR-024 locale choice does not persist across sessions

**Finding**: T023 only covered immediate `dir` re-render on locale switch, not persistence across sessions as
FR-024 requires.

**Resolution**:
- data-model.md: added `Account.preferred_locale` field.
- Added T103 (US1 test): asserts a locale choice survives logout/login in a fresh session, distinct from T023's
  immediate re-render check.
- Added T104 (US1 impl): `PATCH /accounts/me/locale` plus wiring `next-intl`'s initial resolution to prefer the
  persisted value once authenticated.

## U1/F7 (MEDIUM) — FR-015 colour-only status encoding not explicitly tested

**Finding**: FR-015 requires status be conveyed by text/label, not colour alone; axe accessibility checks do not
catch colour-only encoding, so no existing task actually verified this.

**Resolution**:
- Added T110 (Polish): explicit assertion that every status/warning/error indicator in scope renders an
  independent text label, not implied by or covered by any axe pass.
- Added a corresponding bullet to plan.md's Test Strategy explicitly distinguishing this from axe coverage.

## G3/F4 (MEDIUM) — FR-002 "additional roles" have no implementation

**Finding**: FR-002 mentions additional owner-assignable roles beyond Workspace Owner, but nothing in
tasks.md implements them.

**Resolution (narrowed wording, per the preferred option)**:
- spec.md FR-002 narrowed to state this slice ships exactly one customer-side role (Workspace Owner, assigned
  automatically), with owner-assignable additional roles explicitly deferred to a named later slice (Spec §28,
  Slice 2+).
- spec.md's Out of Scope section gained an explicit bullet naming this deferral, so it reads as an intentional
  boundary rather than a silent gap.

## F8 (LOW) — Subscription.tenant_id "unique-ish" wording

**Finding**: data-model.md described `Subscription.tenant_id` as "unique-ish (see below)," which is vaguer than
the concrete DB-level unique constraint T011 actually specifies.

**Resolution**: data-model.md now states `tenant_id | UUID, unique`, with the Validation note rewritten to
state plainly that a tenant has exactly one Subscription row (DB-level unique constraint, matching T011),
period-over-period changes update that same row, and history lives in `PaymentSubmission.status_history`.

## Summary of new tasks

| Task | Phase | Finding(s) |
|---|---|---|
| T099 | Foundational | C1 |
| T100 | Foundational | C1 |
| T101 | Foundational | F2 |
| T102 | Foundational | F2 |
| T103 | US1 (test) | U2 |
| T104 | US1 (impl) | U2 |
| T105 | US3 (test) | F3 |
| T106 | US3 (impl) | F3 |
| T107 | US3 (impl) | F3 |
| T108 | Polish | G2 |
| T109 | Polish | G1/F6 |
| T110 | Polish | U1/F7 |
| T111 | Polish | F2 (test) |
| T112 | Polish | C1 (test) |

Existing tasks edited in place (no ID change): T009, T010, T021, T044, T076, T082, T088.

---

## Round 2 remediation

Codex independently re-reviewed the remediation above, confirmed all 12 original findings (C1, F1, F2, F3, I1,
G2, G1/F6, F5, U2, U1/F7, G3/F4, F8) RESOLVED, and found 7 new structural problems introduced by that
remediation itself. All 7 are fixed below, editing only spec.md/plan.md/data-model.md/tasks.md/
contracts/openapi.yaml/contracts/events.md — no application code. Task IDs T001–T112 are unchanged; one new
task (T113) was appended where a genuine contract-authoring gap existed. No task was renumbered.

### 1. Feature-flag UI gating missing from the frontend surface tasks

**Finding**: data-model.md:84 requires a disabled `FeatureFlag` to hide the corresponding customer-facing
surface entirely, but T077/T083/T091 (the US4/US7/US8 frontend screens) and T112 (the cross-cutting
feature-flag test) only asserted HTTP-level guard denial — never that the rendered UI/navigation actually
hides the surface.

**Resolution**:
- tasks.md T077 (`frontend/src/app/(onboarding)/modules/page.tsx`), T083
  (`frontend/src/app/(onboarding)/checklist/page.tsx`), and T091
  (`frontend/src/app/(onboarding)/support-access/page.tsx`) each gained an explicit acceptance-criteria clause:
  when the relevant `FeatureFlag.enabled=false`, the route and any navigation entry to it are absent from the
  rendered UI entirely — not a disabled link, not a reachable-but-blocked page.
- tasks.md T112 was expanded from an HTTP-only integration test to also require a rendered-UI Playwright spec
  (`frontend/tests/e2e/feature-flag-ui-gating.spec.ts`), with Dependencies extended to include T077, T099,
  T083, T091, T100 so the UI surfaces it must inspect actually exist.

### 2. TrialWindowGuard not attached to all three FR-030a onboarding paths

**Finding**: T101 (`TrialWindowGuard`) was never listed as a dependency/acceptance-criterion of T054 (company
setup), T076 (module selection), or T082 (checklist) — spec.md:231's three FR-030a onboarding paths were left
structurally unenforced at the task level, even though T111's cross-cutting test implied enforcement existed.

**Resolution**:
- tasks.md T054 (`tasks.md:616`), T076 (`tasks.md:847`), and T082 (`tasks.md:910`) each now list T101 as an
  explicit Dependency and require, in their Acceptance Criteria, that `TrialWindowGuard` denies both the
  documented UI-shaped call and a raw HTTP replay identically once the trial window has elapsed.
- tasks.md T111 was rewritten to name all three endpoints explicitly (`PUT /companies/current/setup`,
  `PUT /modules/selection`, `GET /onboarding/checklist`) and require each be tested through both UI-shaped and
  raw HTTP requests (6 denial cases total), with Dependencies extended to T054, T076, T082.

### 3. T105/T106 status-code contradiction on the pre-completion response (403 vs. 409)

**Finding**: T105 (`tasks.md:601`, prior text) stated 403 for calling `/companies/current/settings` before
`Company.setup_complete=true`; T106 (`tasks.md:647`, prior text) stated 409 for the same condition.

**Resolution**: Reconciled to a single canonical **409**, documented once in `contracts/openapi.yaml`'s new
`/companies/current/settings` path (see fix 4 below — this path did not previously exist in the OpenAPI file at
all, despite being referenced by T105/T106). tasks.md T105 and T106 were both rewritten to state the code is
"the single canonical 409 documented in `contracts/openapi.yaml`" rather than restating a number independently,
eliminating the possibility of future drift between the two tasks.

### 4. Locale endpoint (`PATCH /accounts/me/locale`, T104) had no OpenAPI contract task

**Finding**: T104 (`tasks.md:449`) implements `PATCH /accounts/me/locale`, and T024 (`tasks.md:255`) generates
the frontend API client from `contracts/openapi.yaml`, but the locale path never existed in that file — the
frontend client had no type to generate against.

**Resolution**:
- Added `PATCH /accounts/me/locale` (with a new `LocaleUpdateRequest` schema, 200/422 responses) to
  `contracts/openapi.yaml`.
- Added new task **T113** (Foundational phase, alongside T099–T102) whose sole job is this contract addition,
  with no code dependencies of its own.
- tasks.md T024's Dependencies gained `T113`; tasks.md T104's Dependencies gained `T113` — both now strictly
  ordered after the contract exists, closing the contract-first gap.

### 5. Odoo-exposure sweep (T109) scoped to a subset of customer-facing screens

**Finding**: T109 is SC-011's full-surface sweep but only listed billing, checklist, module selection, support
access, and the Billing Admin review queue — omitting public/auth screens, the provisioning-status screen, and
the company-settings screen (all customer-facing per FR-013 or, for company settings, added in the prior
remediation round).

**Resolution**: tasks.md T109 rewritten to cover the public plan list (T036), signup (T037), verify-email
(T038), MFA enrollment (T039), provisioning status (T048), the setup wizard (T052/T056), company settings
(T107), billing (T063), module selection (T077), the checklist (T083), support access (T091), and the Billing
Admin review queue (T071) — the complete customer-facing surface, not a subset. Dependencies extended
accordingly.

### 6. Colour-independence test (T110) scoped to lifecycle states only

**Finding**: T110 covered only billing/support-access/provisioning lifecycle labels (Pending Review, Approved,
Rejected, Request More Information, expired/active grant, provisioning states), omitting every other
status/warning/error indicator FR-012/FR-015 require to be colour-independent.

**Resolution**: tasks.md T110 rewritten to also cover signup/verification errors (T038), setup-wizard
validation and configuration-gap errors (T056), payment-proof upload errors (T063), module-selection
blocked/upgrade indicators (T077), and the checklist's activation-gated indicator (T083), in addition to the
original lifecycle-state set. Dependencies extended to T037, T038, T056, T077 (T048/T063/T071/T083/T087
retained).

### 7. Polish-phase dependencies let T097/T098 complete before the remediation tasks they should gate on

**Finding**: T097's Dependencies read `T001–T096`, excluding T099–T107 (`tasks.md:1048`); T098 depended only on
T097 while claiming all four automated verification entry points were green, even though T108–T112 (CI wiring
and the full-surface sweeps) could run — or not run — independently and later (`tasks.md:1056`, `tasks.md:1064`).

**Resolution**:
- tasks.md T097's Dependencies changed to `T001–T096, T099–T107`, so documentation reconciliation cannot
  complete before the feature-flag, trial-window, locale-persistence, and company-settings remediation tasks
  exist.
- tasks.md T098's Dependencies changed to `T097, T108, T109, T110, T111, T112`, so the final full-validation
  task cannot claim a green automated suite before CI is actually wired to run it (T108) and the Odoo-exposure,
  colour-independence, trial-window, and feature-flag sweeps (T109–T112) have actually run.

## Round 2 summary of task changes

| Task | Change |
|---|---|
| T024 | Dependencies: added T113 |
| T054 | Dependencies: added T101; Acceptance Criteria: TrialWindowGuard requirement added |
| T076 | Dependencies: added T101; Acceptance Criteria: TrialWindowGuard requirement added |
| T077 | Acceptance Criteria: feature-flag UI-hiding requirement added |
| T082 | Dependencies: added T101; Acceptance Criteria: TrialWindowGuard requirement added |
| T083 | Acceptance Criteria: feature-flag UI-hiding requirement added |
| T091 | Acceptance Criteria: feature-flag UI-hiding requirement added |
| T097 | Dependencies: T001–T096 → T001–T096, T099–T107 |
| T098 | Dependencies: T097 → T097, T108–T112 |
| T104 | Dependencies: added T113; Acceptance Criteria: contract-match requirement added |
| T105 | Acceptance Criteria: 403 → single canonical 409, referencing contracts/openapi.yaml |
| T106 | Acceptance Criteria: restates 409 as the OpenAPI-documented canonical code, contract now actually added |
| T109 | Scope expanded to full customer-facing surface; Dependencies extended |
| T110 | Scope expanded beyond lifecycle states; Dependencies extended |
| T111 | Rewritten to name all 3 FR-030a paths × 2 call shapes explicitly; Dependencies extended |
| T112 | Expanded to add rendered-UI Playwright coverage alongside the HTTP integration test; Dependencies extended |
| **T113** | **New task** (Foundational): contract-first addition of `PATCH /accounts/me/locale` to contracts/openapi.yaml |

Also edited: `contracts/openapi.yaml` gained `/companies/current/settings` (get/put, with `CompanySettingsView`/
`CompanySettingsInput` schemas) and `/accounts/me/locale` (patch, with `LocaleUpdateRequest` schema) — both were
referenced by tasks.md tasks but did not previously exist in the contract file.
