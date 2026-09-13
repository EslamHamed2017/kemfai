# Phase 0 Research: KEMFAI Slice 1 — SaaS Onboarding Shell

All Technical Context fields are resolved below; none remain `NEEDS CLARIFICATION`. Items already frozen in
`docs/GATE0_DECISIONS.md` (Keycloak, MinIO, NestJS, OmniRoute, Odoo 18) are recorded for traceability but not
re-litigated. The rest are implementation-level decisions needed to execute this plan, made against the
Constitution and spec.md, and are **not** further tech-stack lock-ins requiring Owner sign-off — they are
reversible via normal engineering change, unlike the Gate 0 items.

## 1. Control-plane vs. tenant-plane data split

- **Decision**: A single KEMFAI-owned `kemfai_control` PostgreSQL database holds Account, Tenant (registry),
  Plan, Feature, PlanFeatureEntitlement, EntitlementDefault, Subscription, PaymentSubmission,
  SupportAccessGrant/SupportAccessUsage, and the platform AuditEvent log. Each tenant separately gets a
  dedicated `kemfai_tenant_<id>` Odoo/PostgreSQL database for company, module-selection cache, and the records
  the onboarding checklist reads (partners/customers, bank accounts, products).
- **Rationale**: FR-034 requires a Billing Admin to review submissions across tenants in one queue; accounts
  and the tenant registry must exist before a tenant database is provisioned (FR-019/FR-022 ordering); a
  single source of truth is required for idempotent provisioning (FR-023) and for the immutable audit trail
  (FR-008). None of this data is accounting/ledger data, so it does not fall under Constitution Principle IV's
  "no shared accounting database" rule — see plan.md Complexity Tracking for the explicit justification.
- **Alternatives considered**: (a) Store control-plane data inside one designated tenant's Odoo DB — rejected,
  breaks tenant isolation and Billing Admin's cross-tenant view. (b) Duplicate control-plane data into every
  tenant DB — rejected, breaks single-source-of-truth and idempotency guarantees, multiplies audit surfaces.

## 2. Auth topology (building on locked Keycloak decision)

- **Decision**: Two Keycloak realms: `kemfai-customers` (Workspace Owner and future customer roles, one user
  per Account, custom attribute `tenant_id` populated post-provisioning) and `kemfai-internal` (Billing Admin,
  Support, Super Admin, Customer Success, Technical Admin, per Spec §2). Email verification and MFA (TOTP)
  enrollment use Keycloak's native required actions (`VERIFY_EMAIL`, `CONFIGURE_TOTP`) via the Admin REST API,
  rather than custom-built token/OTP logic — reduces custom security-sensitive code, consistent with reusing a
  platform capability instead of reinventing one.
- **Rationale**: FR-004/FR-005 require categorical separation between customer and internal-staff identities;
  reusing Keycloak's built-in verification/MFA flows avoids re-implementing security-critical primitives that
  a hardened IdP already provides.
- **Alternatives considered**: Single realm with role claims — rejected, see plan.md Complexity Tracking.
  Custom-rolled verification tokens/TOTP — rejected as unnecessary re-implementation of what Keycloak already
  provides and hardens.

## 3. Tenant database provisioning mechanism

- **Decision**: A NestJS `integrations/provisioning` service, triggered by the `accounts` module on successful
  email verification, enqueues a BullMQ job keyed by `account_id` (unique job id = dedupe key). The job: (1)
  creates a `Tenant` row in `kemfai_control` in `Pending` state if none exists for that account (unique
  constraint on `account_id` enforces idempotency at the DB level), (2) creates the Odoo database
  `kemfai_tenant_<tenant_id>` via Odoo's database-management JSON-RPC endpoint, (3) installs the `kemfai_*`
  addons and seeds one initial `res.company`, (4) marks the tenant `Ready`. Any failure moves the tenant to
  `Failed` with the error recorded as an audit event (FR-007) and the job is safely retryable from the last
  incomplete step (steps are individually idempotent: "create if not exists" at each step).
- **Rationale**: FR-023 mandates idempotent provisioning; FR-022 mandates automatic, single tenant/company
  creation; the edge case in spec.md ("failure after workspace record created but before DB finishes") requires
  a durable, resumable state machine rather than a single synchronous call.
- **Alternatives considered**: Synchronous provisioning inline in the verification HTTP request — rejected,
  DB/addon-install latency risks request timeouts and doesn't survive process restarts mid-provisioning.

## 4. Entitlement / trial-window configuration (FR-030, FR-030a)

- **Decision**: `PlanFeatureEntitlement(plan_id, feature_key, enabled, limit_value)` rows drive module-selection
  and future usage checks. A parallel `PlanSetting(plan_id, trial_window_days NULLABLE, auto_restrict_unpaid
  BOOLEAN)` row per plan carries FR-030a's values. A single `EntitlementDefault` singleton row (not a code
  constant) carries the documented fallback (`trial_window_days = 14`) used only when a plan's own
  `PlanSetting.trial_window_days` is null — kept as data specifically so the "default" itself is editable by a
  Super Admin later without a code change, per FR-030a's explicit requirement that nothing here be hard-coded.
- **Rationale**: Directly satisfies FR-030/FR-030a and Principle I P-07. Keeping the 14-day fallback as a data
  row (not a `const TRIAL_DAYS = 14`) closes the gap where a "default" could otherwise sneak back in as a
  hard-coded value.
- **Alternatives considered**: Hard-coded fallback constant in application code — rejected explicitly by
  FR-030a's wording ("MUST NOT be hard-coded in application logic").

## 5. Evidence storage layout (building on locked MinIO decision)

- **Decision**: One MinIO bucket per tenant, `kemfai-tenant-<tenant_id>`, created at Tenant-registry-record
  creation (ahead of the Odoo DB step), holding payment-proof objects under
  `payment-submissions/<submission_id>/<filename>`. Bucket policy denies all access except the API/BFF's
  service credentials; the BFF issues short-lived presigned URLs for upload and for Billing Admin review
  fetches.
- **Rationale**: Mirrors the DB-per-tenant isolation principle at the object-storage layer and avoids
  cross-tenant object listing even in the event of an application-layer authorization bug (defense in depth for
  Principle IV's spirit). Presigned URLs keep raw storage credentials off the client, consistent with
  Principle III (BFF-mediated access only).
- **Alternatives considered**: Single shared bucket with tenant-id key prefixes — rejected as weaker isolation
  (a single IAM/policy mistake exposes all tenants' evidence at once).

## 6. Background job / queue mechanism

- **Decision**: BullMQ on Redis for provisioning, verification-email dispatch, and notification delivery
  (Billing Admin decision notices, support-access expiry sweeps).
- **Rationale**: Spec §21 requires "a job/queue mechanism for imports, reports, notifications, connectors and
  AI tasks"; BullMQ is the standard, well-supported choice in the NestJS/Node ecosystem and integrates with
  NestJS's `@nestjs/bullmq` module with minimal custom glue.
- **Alternatives considered**: Postgres-backed job table with polling — rejected as unnecessary reinvention
  given BullMQ is already idiomatic for this stack; revisit only if Redis becomes an unwanted operational
  dependency.

## 7. Frontend i18n/RTL mechanism

- **Decision**: `next-intl` for message catalogs and locale routing; `dir="rtl"|"ltr"` set at the root
  `<html>` element from the resolved locale; Carbon Design System's logical-property-based components (Carbon
  v11 ships RTL-aware components) as the base layer, customized per the KEMFAI Financial Design Layer (Spec
  §20) rather than stock Carbon visuals.
- **Rationale**: Directly required by FR-014/FR-024/SC-005 and Constitution Principle V; Carbon is the locked
  design-system base (Gate 0 / Spec §20).
- **Alternatives considered**: `react-i18next` — rejected only for consistency with Next.js App Router
  server-component patterns that `next-intl` targets natively.

## 8. Support-access expiry enforcement (FR-039/FR-041, SC-009)

- **Decision**: Expiry is enforced at read-time (every access check compares `now()` against
  `SupportAccessGrant.expires_at` and `revoked_at`, both indexed) *and* by a BullMQ scheduled sweep every 30
  seconds that flips any newly-expired grant's `status` to `Expired` and emits an audit event, so SC-009's
  "inaccessible within 1 minute of expiry, zero manual revocation" holds even if no access attempt occurs to
  trigger a lazy check.
- **Rationale**: A purely lazy (read-time only) check would satisfy "inaccessible" but would not itself produce
  the "enforcement" audit event required by the edge-case requirement ("logs enforcement (successful block) at
  the moment of an expired-access attempt") for grants nobody tries to use — the sweep guarantees the state
  transition is observable independent of access attempts.
- **Alternatives considered**: Read-time-only lazy expiry — rejected, insufficient for SC-009's proactive
  1-minute bound when no access attempt occurs.

## 9. Onboarding checklist source of truth

- **Decision**: Checklist items are computed on read from live Odoo records (partner exists, bank account
  exists, product exists) via the `kemfai_onboarding_checklist` addon's computed fields/views, exposed through
  the BFF `checklist` module — never stored as an independently-mutable "done" flag.
- **Rationale**: Directly required by spec.md's Key Entities section ("derived from underlying records rather
  than stored as an independent source of truth") and the edge case requiring reversion to incomplete if the
  underlying record is deleted (FR-037, SC-010).
- **Alternatives considered**: Cached/materialized checklist state updated via domain events — rejected for
  Slice 1 as unnecessary complexity; revisit only if computed-read latency becomes a measured problem.

## Summary of resolved Technical Context

No `NEEDS CLARIFICATION` markers remain. All decisions above are consistent with `docs/GATE0_DECISIONS.md`
locked items and the ratified constitution; none require Owner approval since none touch a locked baseline
decision (Constitution Governance clause) — they are implementation details within the already-locked stack.
