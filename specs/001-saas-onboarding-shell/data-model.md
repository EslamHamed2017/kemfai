# Phase 1 Data Model: KEMFAI Slice 1 — SaaS Onboarding Shell

Entities are grouped by where they physically live, per research.md §1. `tenant_id` on a control-plane entity
is a logical scoping foreign key enforced by the API/BFF (FR-001) — it does not imply physical storage inside a
tenant database. All entities use immutable primary IDs (UUID) per Constitution Principle VII/§22.

## Control-plane database (`kemfai_control`)

### Account
Identity record backing a Keycloak `kemfai-customers` user.

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Immutable |
| keycloak_user_id | UUID | FK to Keycloak `kemfai-customers` realm user |
| email | citext, unique | Business email |
| email_verified | boolean | Mirrors Keycloak state; gates all tenant access (FR-019) |
| mfa_enrolled | boolean | Mirrors Keycloak `CONFIGURE_TOTP` completion (FR-020) |
| selected_plan_id | UUID, nullable | FK → Plan; carried from plan-selection into signup (FR-017) |
| selected_billing_cycle | enum(monthly, annual), nullable | Carried alongside plan |
| preferred_locale | enum(en, ar), nullable | Persists the FR-024 locale choice across sessions; read on login/session-refresh so the correct `dir`/language is applied before any client-side detection (U2 remediation — see analysis.md) |
| created_at, updated_at | timestamptz | |

**Validation**: email format + uniqueness enforced pre-Keycloak-create; duplicate signup against an already
verified email is rejected without revealing account existence beyond "sign in or reset password" (FR-018,
Acceptance Scenario 1.6). Unverified duplicate → resend verification, no second Account row (edge case).

**State**: `Unverified → Verified` (one-way; re-verification requests do not create new Accounts).

### Tenant
The tenant/workspace registry entry. One row per verified Account (1:1, unique on `account_id`).

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | This is *the* tenant identifier propagated everywhere (FR-001) |
| account_id | UUID, unique | FK → Account (owner); enforces idempotent provisioning (research.md §3) |
| status | enum(Pending, Creating, Ready, Failed) | Provisioning state machine |
| odoo_db_name | text, nullable | Set once DB is created (`kemfai_tenant_<id>`) |
| minio_bucket | text, nullable | Set at registry-creation time (research.md §5) |
| provisioning_attempts | int | For observability/backoff |
| failure_reason | text, nullable | Set when status = Failed |
| created_at, ready_at | timestamptz | |

**State machine**: `Pending → Creating → Ready`, or `Creating → Failed` (retryable back to `Creating`, never
silently re-enters `Ready` without completing all steps — research.md §3). No cross-tenant fallback, no
partially-usable state is ever surfaced to the user (edge case, Acceptance Scenario 2.4/2.5).

**Provisioning order**: `minio_bucket` MUST be created and set before `odoo_db_name` is created — plan.md's
Storage section fixes this ordering ("bucket is created at tenant-registry-record creation time, ahead of Odoo
DB provisioning"), and T044 (F1 remediation — see analysis.md) now implements this explicit step, since payment-
proof upload (US5) only ever happens after a tenant is registered but has no dependency on the Odoo DB existing.

### Plan / Feature / PlanFeatureEntitlement / PlanSetting / EntitlementDefault
The entitlement engine (FR-030/FR-030a).

- **Plan**: id (PK), name, published (bool), monthly_price, annual_price, currency, created_at, updated_at.
- **Feature**: id (PK), key (unique, e.g. `module.accounting`, `module.projects`), display_name, kind
  (enum: module, limit).
- **PlanFeatureEntitlement**: plan_id (FK), feature_key (FK), enabled (bool), limit_value (numeric, nullable) —
  composite PK (plan_id, feature_key). This is the *only* table any module-selection or usage-limit check reads
  (FR-030) — no plan-name branching anywhere in code.
- **PlanSetting**: plan_id (PK, FK), trial_window_days (int, nullable — null means "use default"),
  auto_restrict_unpaid (bool, nullable — null means "use default"). Both columns follow the identical
  nullable-fallback pattern; neither carries an in-column default, so there is no contradiction between a
  documented default and a "use default" sentinel. Carries FR-030a values, editable per plan without a code
  change.
- **EntitlementDefault**: singleton row (id fixed), default_trial_window_days (int, seeded 14),
  default_auto_restrict_unpaid (bool, seeded true). `default_trial_window_days` is read only when
  `PlanSetting.trial_window_days IS NULL`; `default_auto_restrict_unpaid` is read only when
  `PlanSetting.auto_restrict_unpaid IS NULL`, for the tenant's plan — mirroring the trial-window fallback exactly
  (I1 remediation — see analysis.md).

### FeatureFlag
Config-driven module-gating mechanism satisfying Constitution Principle VI ("Incomplete modules MUST sit behind
feature flags"). Lives alongside the entitlement tables above and is read through the same `EntitlementsService`
(T010/T099) — never a second, ad-hoc config path (C1 remediation — see analysis.md).

| Field | Type | Notes |
|---|---|---|
| feature_key | text (PK, FK → Feature.key) | One row per gate-able feature/module |
| enabled | boolean, default false | Safe default is hidden/off; a module is exposed to any tenant only once explicitly turned on |
| notes | text, nullable | Free-text rationale (e.g. "US7 checklist — gate until Polish sweep passes") |

**Validation**: `FeatureFlag.enabled=false` hides the corresponding customer-facing surface entirely (not merely
disables an action) for every tenant regardless of plan/entitlement, applied via `FeatureFlagGuard` on both
UI-driven and raw HTTP paths (same FR-006 pattern as `TenantScopeGuard`/`RoleGuard`). This is independent of
`PlanFeatureEntitlement` (which governs what a *paying* tenant's plan allows) — a feature can be fully entitled
by plan and still hidden platform-wide while incomplete.

**Validation**: `published=false` plans are excluded from the public plan list (FR-016) and, if a visitor's
in-flight selection references a plan that becomes unpublished before signup completes, the signup step
re-validates and prompts re-selection (Edge Cases).

### Subscription
The billing relationship for a tenant.

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| tenant_id | UUID, unique | FK → Tenant |
| plan_id | UUID | FK → Plan |
| billing_cycle | enum(monthly, annual) | |
| status | enum(PendingActivation, Active, Suspended, Cancelled) | Lifecycle per Spec §19, scoped to this feature's slice (Trial/PendingActivation → Active only, via Billing Admin) |
| current_period_start, current_period_end | date | Billing period in scope for review (FR-031) |
| activated_at, activated_by | timestamptz, UUID (internal Account), nullable | Set only on approval (FR-036) |
| created_at, updated_at | timestamptz | |

**Validation**: `tenant_id` carries a DB-level unique constraint (matching T011) — a tenant has exactly one
Subscription row, full stop; renewal for a new period updates `current_period_start/end` on that same row, and
period-over-period history is tracked via PaymentSubmission's `status_history`, not by inserting a new
Subscription row per period (F8 remediation — see analysis.md; previous "unique-ish" wording is replaced with
this concrete constraint).

**Trial-window enforcement (FR-030a, F2 remediation)**: Enforcement is computed at read-time by `TrialWindowGuard`
(T101) from `Tenant.ready_at` + `EntitlementsService`'s resolved `trialWindowDays`, compared against `now()`, and
only applies while this Subscription's `status` is not `Active`. When elapsed time exceeds the window and the
resolved `autoRestrictUnpaid` is true, `TrialWindowGuard` denies onboarding-scoped access (company setup, module
selection, checklist) the same way `TenantScopeGuard` denies cross-tenant access — no new persisted "restricted"
column is introduced, mirroring `SupportAccessGrant`'s equivalent computed-expiry pattern. A scheduled
`trial.expiry_sweep` job (T102, contracts/events.md) mirrors `support_access.expiry_sweep` (T090) to proactively
emit a `tenant.trial.restricted` audit event the first time a tenant crosses the threshold, for
observability/notification — it does not itself gate access, since the guard already enforces it live.

### PaymentSubmission
A customer's claim of payment for one billing period (FR-032–FR-036).

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| tenant_id | UUID | FK → Tenant (denormalized for query/audit convenience) |
| subscription_id | UUID | FK → Subscription |
| billing_period_start, billing_period_end | date | Must match Subscription's expected period |
| amount, currency | numeric, char(3) | Snapshot of amount due at submission time |
| bank_reference | text | Unique payment reference shown to customer (FR-031) |
| proof_object_key | text | MinIO object key (tenant bucket), never a DB blob |
| status | enum(PendingReview, Approved, Rejected, MoreInfoRequested) | |
| submitted_at | timestamptz | |
| reviewed_by, reviewed_at | UUID (internal Account), timestamptz, nullable | Billing Admin identity (FR-009) |
| decision_notes | text, nullable | |
| status_history | jsonb (append-only array) | Every transition, including repeated MoreInfoRequested cycles (Edge Cases) |

**Validation**: Unique partial index on `(tenant_id, billing_period_start, billing_period_end)` WHERE `status IN
('PendingReview', 'MoreInfoRequested')` — enforces FR-033 (no second concurrent submission for the same period)
at the database level, not just in application logic. File type/size validated before row creation (FR-032
edge case) — rejected uploads never create a row.

**State machine**: `PendingReview → {Approved | Rejected | MoreInfoRequested}`; `MoreInfoRequested →
PendingReview` (resubmission), preserving prior cycles in `status_history` (Acceptance Scenario 5.5, Edge
Cases). `Approved` is terminal for that submission and triggers Subscription activation atomically in the same
transaction (FR-036) — an already-`Active` tenant/period combination blocks a second approval (Acceptance
Scenario 6.6) via a check against Subscription.status + current_period before applying the decision.

### SupportAccessGrant / SupportAccessUsage
Customer-authorized, time-bounded internal access (FR-039–FR-041).

- **SupportAccessGrant**: id (PK), tenant_id (FK), granted_by (Account id, must be Workspace Owner), grantee_role
  (enum from internal roles, e.g. Support), expires_at (timestamptz, mandatory, not null), revoked_at
  (timestamptz, nullable), created_at.
- **SupportAccessUsage**: id (PK), grant_id (FK), used_by (internal Keycloak `kemfai-internal` user id),
  used_at, action_summary (text), was_denied (bool), denial_reason (text, nullable — e.g. "expired", "revoked").

**Validation**: Every access attempt (allowed or denied) writes a SupportAccessUsage row (FR-041, Acceptance
Scenario 8.3). `expires_at` enforced both at read-time and by the scheduled sweep (research.md §8); revocation
sets `revoked_at` immediately and is itself an audit event (FR-040, Acceptance Scenario 8.4).

### AuditEvent
Platform-wide, append-only audit log (FR-007–FR-009).

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| occurred_at | timestamptz | |
| actor_type | enum(account, internal_user, system) | "system" for automated actions (FR-008) |
| actor_id | UUID, nullable | Null only when actor_type=system |
| tenant_id | UUID, nullable | Null only for pre-tenant events (e.g., signup before verification) |
| action | text (enum-like, versioned key, e.g. `tenant.provisioning.failed`) | |
| subject_type, subject_id | text, UUID | Polymorphic reference to the entity concerned (source linkage) |
| payload | jsonb | Action-specific fields; for billing decisions, includes every field FR-009 requires |
| created_at | timestamptz | Immutable once written; no UPDATE/DELETE grants on this table at the DB role level |

**Validation**: Append-only enforced by revoking UPDATE/DELETE privileges on this table from the API/BFF's
database role; only INSERT is permitted, satisfying "immutable once written" (FR-008) at the infrastructure
level, not just by convention.

## Tenant database (`kemfai_tenant_<id>`, via `kemfai_*` Odoo addons)

### Company (extends `res.company` via `kemfai_company_setup`)
Setup-wizard attributes layered onto the initial Odoo company created during provisioning.

| Field | Type | Notes |
|---|---|---|
| country | Many2one res.country | Drives country-dependent validation (FR-026) |
| legal_name, trade_name | char | Company identity (FR-025) |
| base_currency | Many2one res.currency | |
| fiscal_year_start_month/day | Selection/Integer | Fiscal year definition |
| vat_tax_registration | char | Format validated per `country` |
| industry | Many2one / Selection | |
| accounting_setup_template | Selection | Initial COA template choice only (Assumptions — not full COA config) |
| setup_wizard_step | Selection | Current/resume step (FR-027) |
| setup_complete | boolean | Set true only when all required steps submitted (FR-028) |
| setup_completed_at | datetime | Drives the audit event on completion (Acceptance Scenario 3.7) |

**Validation**: Country-dependent field formats come from a per-country validation-rule table shipped in
`kemfai_company_setup`; if a launch country has no rule defined, the wizard step blocks with a configuration-gap
error rather than silently accepting the value (Edge Cases — "must not silently accept unvalidated data").

**Concurrency**: Last-write-wins per field with an updated-at check surfaced to the second-tab user as a
non-silent "this value was updated elsewhere" indicator (Edge Cases — two wizard sessions).

**Post-completion editing (FR-028, F3 remediation — see analysis.md)**: Once `setup_complete=true`, these same
fields MUST also be reachable and editable through a distinct company-settings surface (T106/T107) — not solely
by re-entering the wizard flow (T054). Both surfaces write the same underlying fields; the wizard remains the
only path before `setup_complete=true`.

### ModuleSelection (`kemfai_module_selection`)
Per-tenant cache of which entitled modules/features are enabled.

| Field | Type | Notes |
|---|---|---|
| feature_key | char | Must exist as an entitled Feature for the tenant's current plan (cross-checked against control-plane PlanFeatureEntitlement on every write, FR-006/FR-029) |
| enabled | boolean | |
| updated_at, updated_by | datetime, ref | Drives module-selection-changed audit event (FR-007) |

**Validation**: Enabling a feature_key not present/enabled in the tenant's current PlanFeatureEntitlement is
rejected server-side regardless of caller (BFF, direct API replay) — FR-006, Edge Cases ("via a direct request
rather than the UI").

### Onboarding checklist source records
No new table — `kemfai_onboarding_checklist` exposes **computed** booleans over existing Odoo models:
`customer_added` (`res.partner` with customer rank > 0 exists), `bank_added` (`res.partner.bank` or
`account.journal` of type bank exists), `product_added` (`product.product` exists),
`first_invoice_ready` (all three above true). Nothing here is stored as an independent "done" flag (Key
Entities — "derived... rather than stored"), so deleting the underlying record reverts the item automatically
(Edge Cases, SC-010).

## Cross-cutting: Roles & Scopes (FR-002–FR-006)

| Role | Realm | Scope | Key permissions in this feature |
|---|---|---|---|
| Workspace Owner | kemfai-customers | Own tenant only | Full onboarding flows, module selection, payment submission, support-access grant/revoke |
| Billing Admin | kemfai-internal | Cross-tenant (all PaymentSubmissions) | Approve/reject/request-more-info; MUST NOT self-approve as a customer (FR-004 — enforced by realm separation, no Account can hold this role) |
| Support | kemfai-internal | Only tenants with an active, unexpired, unrevoked grant | Access scoped to grant; every action logged (FR-005, FR-041) |
| Super Admin / Customer Success / Technical Admin | kemfai-internal | Cross-tenant, read/administrative | Read tenant/subscription records; this feature does not add write surfaces for them beyond what's specified |

All checks above are implemented once, in NestJS guards (`backend/api/src/common/guards`), applied identically
to every entry path (UI-triggered, direct API call, or replay) — satisfying FR-006 structurally rather than
per-endpoint.
