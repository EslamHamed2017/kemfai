# KEMFAI SaaS Onboarding Shell — As-Built Validation Guide

**Task:** T097
**As-built baseline:** T001–T112 (including T096 and T099–T112 remediation)
**Audience:** developers, reviewers, and operators validating the current onboarding shell
**Canonical contracts:** [`contracts/openapi.yaml`](contracts/openapi.yaml) and [`contracts/events.md`](contracts/events.md)

This guide reconciles the original walkthrough with the implemented system. It is a validation guide, not a production deployment runbook. When this guide and a historical progress note disagree, the committed contract and current code win.

## 1. Prerequisites and topology

### Tooling

- Docker Engine with Compose v2.
- Node.js **22.22.0** (the version pinned by CI) and npm.
- A Playwright Chromium installation for browser suites.
- `curl`, Python 3, and OpenSSL for the owned fixture scripts.

Install dependencies from the repository root:

```bash
npm --prefix backend/api ci
npm --prefix frontend ci
```

### Environment

Copy the tracked template and replace every deployment-specific placeholder:

```bash
cp infra/.env.example infra/.env
```

Compose refuses to render until all six required values are set:

- `KEYCLOAK_USERS_CLIENT_SECRET` — a non-default secret for the scoped `kemfai-users-provisioner` service account.
- `KEMFAI_ODOO_MASTER_PASSWORD` — must match the development Odoo configuration used by this stack.
- `KEMFAI_TENANT_ADMIN_LOGIN` and `KEMFAI_TENANT_ADMIN_PASSWORD` — bootstrap credentials for newly provisioned tenant databases.
- `KEMFAI_BANK_TRANSFER_INSTRUCTIONS_EN` and `KEMFAI_BANK_TRANSFER_INSTRUCTIONS_AR` — owner-provided customer instructions, never invented defaults.

Also review the support-access duration and public URLs before starting the stack. Never commit `infra/.env` or fixture secrets.

### Implemented Compose stack

`infra/docker/docker-compose.yml` already defines all seven services; do **not** add duplicate services:

| Service | Local address | Purpose |
|---|---|---|
| `kemfai-db` | internal only | PostgreSQL control plane and Odoo databases |
| `kemfai-odoo` | `http://localhost:8090` | Odoo 18 dev runtime |
| `redis` | internal only | BullMQ queues and scheduled sweeps |
| `minio` | `http://localhost:9000` (`9001` console) | tenant-private objects and payment proof |
| `keycloak` | `http://localhost:8080` | customer and internal identity realms |
| `api` | `http://localhost:4000` | NestJS API |
| `frontend` | `http://localhost:3010` | Next.js shell and BFF |

Use the Compose file explicitly from the repository root. On a fresh environment, start the infrastructure tier first:

```bash
docker compose --env-file infra/.env -f infra/docker/docker-compose.yml \
  up -d --build kemfai-db kemfai-odoo redis minio keycloak
```

The API container uses the least-privileged `kemfai_api` database role and the scoped Keycloak service account. Compose does **not** run TypeORM migrations or `seed:dev`. For this disposable development stack, use the database owner only in one-shot migration/seed containers, then grant the runtime role its intended table/sequence access while retaining append-only `audit_event` restrictions:

```bash
docker compose --env-file infra/.env -f infra/docker/docker-compose.yml build api

docker compose --env-file infra/.env -f infra/docker/docker-compose.yml run --rm --no-deps \
  -e CONTROL_DB_USER=odoo -e CONTROL_DB_PASSWORD=kemfai_dev_pg \
  api npm run migration:run

docker compose --env-file infra/.env -f infra/docker/docker-compose.yml run --rm --no-deps \
  -e CONTROL_DB_USER=odoo -e CONTROL_DB_PASSWORD=kemfai_dev_pg \
  api npm run seed:dev

docker compose --env-file infra/.env -f infra/docker/docker-compose.yml exec -T kemfai-db \
  psql -v ON_ERROR_STOP=1 -U odoo -d kemfai_control <<'SQL'
GRANT USAGE ON SCHEMA public TO kemfai_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kemfai_api;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO kemfai_api;
REVOKE UPDATE, DELETE ON TABLE audit_event FROM kemfai_api;
SQL
```

These owner credentials are committed **development-only** Compose values, not production guidance. In any deployment, use an operator-owned migration role/process and deployment-owned credentials. Never run the long-lived API as a database owner, expose PostgreSQL merely for convenience, or run migrations as `kemfai_api`.

Once `kemfai_control` is migrated, seeded, and granted, start the application tier:

```bash
docker compose --env-file infra/.env -f infra/docker/docker-compose.yml \
  up -d --build api frontend
```

The development seed creates the published `Growth (dev seed)` plan and the seeded entitlement defaults. The development seed enables only `module.accounts`; all other incomplete-module flags remain fail-closed until an operator explicitly enables them.

Verify the running stack rather than trusting container state alone:

```bash
curl -fsS http://localhost:4000/
curl -fsS http://localhost:3010/
curl -fsS http://localhost:8080/realms/kemfai-customers/.well-known/openid-configuration
```

Stop only this Compose project when finished:

```bash
docker compose --env-file infra/.env -f infra/docker/docker-compose.yml down --remove-orphans
```

## 2. Cross-cutting mechanics that affect every walkthrough

### Feature flags are separate from plan entitlements

A plan entitlement answers whether a subscribed plan includes a module. `FeatureFlag.enabled` answers whether the platform surface exists at all. The implemented guarded keys are:

- `module.accounts`
- `module.company_setup`
- `module.module_selection`
- `module.onboarding_checklist`
- `module.support_access`

A missing or disabled flag is fail-closed: guarded API calls return **404**, not a 403 entitlement denial. For the module-selection, checklist, and support-access surfaces, rendered-UI coverage additionally proves that the route is unreachable through navigation and no gated screen remains in the DOM. To exercise walkthroughs 3, 4, 7, and 8, an operator must explicitly enable their matching flags in the prepared validation database. Restore the original flag values after validation.

Canonical dual-shape and rendered-UI proof:

```bash
export T112_FIXTURE_LABEL='kemfai.phase12.operation=t112-feature-gating-repair-20261025T113424Z'
export T112_EVIDENCE_DIR="$(mktemp -d /tmp/kemfai-t112-evidence.XXXXXX)"
bash scripts/test_t112_owned_fixture.sh backend
bash scripts/test_t112_owned_fixture.sh ui
```

The owned script creates and removes only resources bearing its exact ownership label.

### Trial-window enforcement

The specification and T111 define three onboarding-scoped paths:

- `PUT /companies/current/setup`
- `PUT /modules/selection`
- `GET /onboarding/checklist`

**Known non-Gate as-built deviation:** both `GET` and `PUT /companies/current/settings` also carry `@EnforceTrialWindow()` in the implementation and advertise the same 403 in OpenAPI, even though FR-030a/T101/T111 enumerate only the three paths above and FR-030 permits post-completion settings edits. This guide records that mismatch rather than silently treating T111's three-path proof as exhaustive. Until the product contract or implementation is deliberately reconciled, validate settings with the as-built trial restriction and track the deviation separately.

Once `Tenant.ready_at + trialWindowDays` has passed, an unpaid tenant is denied when the resolved `autoRestrictUnpaid` value is true. An `Active` subscription or a resolved false value bypasses the restriction. The 30-second `trial.expiry_sweep` emits `tenant.trial.restricted` at most once per tenant; the live guard still denies access if a sweep is delayed.

Canonical integration proof (the generic integration gate also executes this suite):

```bash
npm --prefix backend/api run test:integration -- \
  --runInBand --runTestsByPath test/integration/trial-window-enforcement.integration-spec.ts

export T111_FIXTURE_LABEL='kemfai.phase11.operation=t111-trial-enforcement-20261025T003529Z'
export T111_EVIDENCE_DIR="$(mktemp -d /tmp/kemfai-t111-evidence.XXXXXX)"
bash scripts/test_t111_integration.sh focused
bash scripts/test_t111_integration.sh regression
```

The exact-owned T111 fixture proves real PostgreSQL/Redis behavior and cleanup. Together these gates cover the three FR-030a paths × two call shapes, both bypasses, and sweep idempotency; they do not prove the additional company-settings deviation noted above.

### Locale persistence

Before authentication, locale resolution remains browser/URL driven. After authentication, the persisted `Account.preferred_locale` wins. The UI switcher updates the locale cookie and calls `PATCH /api/accounts/me/locale`, which forwards to `PATCH /accounts/me/locale`. Validate persistence by switching language, logging out, clearing client-only state, logging back in, and confirming that the previously selected language and `dir` return.

```bash
cd frontend
npx playwright test tests/e2e/locale-persistence.spec.ts
```

### Company settings are not the setup wizard

`/setup-wizard` performs initial configuration. After completion, `/company-settings` uses the distinct `GET`/`PUT /companies/current/settings` surface. Access before `setupComplete=true` returns **409** with the `CompanySetupIncompleteError` contract; post-completion edits do not require rerunning the wizard and emit `company.settings.updated` with `changed_fields[]`.

### Security hardening

- Every MinIO presigned URL is capped at **300 seconds**; an override above 300 is rejected before signing.
- `POST /accounts/signup` allows 5 requests per minute per resolved client IP.
- `POST /accounts/verify-email` allows 10 requests per minute per resolved client IP.
- A limit breach returns localized **429**, `Retry-After`, and rate-limit headers.
- The deployment uses one trusted reverse-proxy hop; arbitrary forwarded client IPs are not trusted directly.
- Disabled account surfaces still return feature-hiding 404 before rate limiting.
- Keycloak user provisioning uses the scoped service account only; there is no bootstrap-admin fallback.

Canonical repository runtime proof:

```bash
bash scripts/test_t096_security_hardening.sh
```

## 3. Eight as-built walkthroughs

Use the browser routes below for UI-shaped validation and the paths in `contracts/openapi.yaml` for raw HTTP replay. Authenticated calls require real customer/internal sessions; do not simulate identity by inventing headers in a deployed environment.

### Walkthrough 1 — Public plans, account, verification, MFA

1. Open `http://localhost:3010/plans`; confirm only published plans and monthly/annual prices appear in English and Arabic.
2. Continue to `/signup`; submit email, strong password, plan, billing cycle, and accepted legal terms.
3. Confirm `POST /accounts/signup` returns 201 and never exposes a Keycloak/Odoo/MinIO implementation detail.
4. Follow the verification link (`/verify?token=...`). Invalid, expired, and reused tokens remain explicit failures; successful verification emits `account.email_verified` once.
5. Open `/mfa`. MFA is optional/non-blocking: **Skip** continues to `/provisioning`. If enabling it, `POST /accounts/mfa/enroll` adds Keycloak's `CONFIGURE_TOTP` required action and the browser completes QR/code setup in Keycloak's hosted flow. `POST /accounts/mfa/confirm` accepts no TOTP code from KEMFAI; it verifies Keycloak credential state and then records enrollment atomically.
6. After successful confirmation, continue to `/provisioning`. The current Ready-state CTA links to `/mfa`; after an intentional skip, navigate explicitly to the next enabled walkthrough surface rather than treating that CTA as proof of automatic progression.
7. Confirm audit events `account.created`, `account.email_verified`, and, only when enabled, `account.mfa_enrolled`.
8. Switch EN ↔ AR, verify RTL mirroring, then log out/in in a fresh context to prove persisted locale behavior.

Expected rate-limit behavior is 5/minute/IP for signup and 10/minute/IP for verify-email, with localized 429 responses and `Retry-After`.

### Walkthrough 2 — Automatic tenant provisioning

1. Complete Walkthrough 1; verified-account processing enqueues tenant provisioning idempotently.
2. Open `/provisioning` or call `GET /tenants/me`; observe only `Pending`, `Creating`, `Ready`, or `Failed` and customer-safe failure text.
3. On `Ready`, verify the control-plane tenant has a unique `odoo_db_name`, tenant-private MinIO bucket, and initial Odoo company.
4. Inspect Odoo through JSON-RPC/operator tooling only; no customer-facing response or DOM may expose Odoo branding, routes, model names, stack traces, or database identifiers.
5. Force a provisioning failure in an isolated fixture; verify `POST /tenants/me/provisioning-retry` moves `Failed` back into the flow without creating a second tenant/database/bucket.
6. Confirm `tenant.provisioning.attempted`, `.failed` or `.succeeded` audit events.

Canonical no-exposure proof:

```bash
bash scripts/test_t109_odoo_exposure.sh all
```

### Walkthrough 3 — Initial company setup and later editing

1. Explicitly enable `module.company_setup` in the prepared validation environment.
2. With a `Ready` tenant inside its permitted trial window, open `/setup-wizard`.
3. Select a supported country and enter legal identity, base currency, fiscal year, VAT/tax profile, industry, and accounting setup.
4. Verify country rules and configuration-gap errors are bilingual, text-labelled, and do not leak Odoo errors.
5. Complete setup; verify `company.setup.completed` and `setupComplete=true`.
6. Open `/company-settings`, change an allowed field, save, and confirm `company.settings.updated` with the changed fields.
7. Replay `GET`/`PUT /companies/current/settings`; confirm pre-completion is 409, unauthorised is 403, completed/authorised inside the permitted trial window is 200, and the current as-built expired/unpaid case is 403 as documented in the deviation above.
8. Confirm Odoo company configuration changed through JSON-RPC without opening native Odoo UI.

### Walkthrough 4 — Module selection

1. Explicitly enable `module.module_selection`.
2. Open `/modules`; confirm the catalog comes from entitlements and never from plan-name branching.
3. Toggle entitled modules and save through `PUT /modules/selection`.
4. Confirm non-entitled modules are visibly upgrade-required and cannot be enabled.
5. Verify selected modules are installed idempotently through Odoo JSON-RPC and `modules.selection.changed` records `added[]` and `removed[]`.
6. Disable the platform flag temporarily: raw and UI-shaped calls must both return 404 and the route/navigation/DOM must disappear. Restore the original flag afterward.

### Walkthrough 5 — Manual bank-transfer payment proof

1. Open `/billing`; confirm bank instructions, the generated reference, expected amount/currency, and period.
2. Upload a supported PDF/JPG/PNG within the configured size limit and submit the bank reference.
3. Verify a tenant-private MinIO object and `Pending Review` status; a duplicate unresolved submission is rejected.
4. Open `/billing-review` as an internal `BillingAdmin` user and request more information with notes.
5. Return as the customer and resubmit corrected proof/reference; status returns to `Pending Review` on the same unresolved submission history.
6. Repeat the request-more-info → customer-resubmission cycle once to prove append-only history; two consecutive internal decisions without resubmission are correctly rejected.
7. Approve the final pending submission; confirm an `Active` subscription for the billing period.
8. Verify `billing.payment_submission.created`, each `billing.payment_submission.decided`, and `billing.subscription.activated`; customer notification is driven by the durable outbox/recovery path.

No Stripe/card gateway is part of V1.

### Walkthrough 6 — Internal billing review

1. Authenticate through the separate internal realm at `/internal-auth/login`.
2. Confirm `BillingAdmin` sees the review queue and can approve, reject, or request more information.
3. Confirm only `BillingAdmin` can read this review queue or perform decisions; Support, Auditor, and customer sessions are denied this controller.
4. Verify every decision carries `reviewed_by`, `reviewed_at`, notes, and append-only status history.
5. Repeat a decision request and verify the service returns conflict rather than creating a second activation or duplicate decision transition.
6. Verify `/internal/audit-events` requires the `ReadOnlyManagement` role and that its optional `tenantId`/`action` filters return the requested audit subset.

### Walkthrough 7 — Onboarding checklist

1. Explicitly enable `module.onboarding_checklist` and open `/checklist`.
2. Confirm the checklist derives steps from source records for verification, MFA, tenant readiness, setup, module selection, payment submission, and subscription activation.
3. Verify setup-readiness and activation-gated state are separate text labels, not colour-only cues.
4. Change a source record and reload; the checklist must reflect the source of truth rather than a duplicated progress table.
5. Disable the flag temporarily; both call shapes return 404 and navigation/DOM hide the surface. Restore it afterward.

### Walkthrough 8 — Time-bounded support access

1. Explicitly enable `module.support_access` and open `/support-access` as a customer owner.
2. Create a grant with the allowed support role and duration; verify `expires_at` is mandatory and bounded by `SUPPORT_ACCESS_MAX_DURATION_HOURS`.
3. As an internal support user, call the allowed read-only workspace-summary endpoint; confirm the grant and tenant scope are enforced.
4. Attempt an unapproved action, another tenant, a revoked grant, and an expired grant; all must be denied and audited without exposing native Odoo UI.
5. Revoke the active grant as the customer and confirm subsequent access fails.
6. Run the expiry sweep twice; state transition and `support_access.grant.expired` occur once.
7. Confirm create/use/deny/revoke/expire events in the audit trail.

## 4. Walkthrough runtime proofs

The following scripts are the canonical runtime proofs behind the walkthroughs. T041/T044 and T050 onward create disposable, exact-owned resources and must never target live services. T039 and T103 are the exceptions: they use the fixed development Compose DB/Redis/Keycloak/API stack, temporarily enable `module.accounts`, and restore its exact prior state on exit. Run T039/T103 only on a disposable development host, never beside a shared or live stack; they do not own or stop that Compose stack.

| Walkthrough | Owned proof |
|---|---|
| 1 — account/auth/MFA | `bash scripts/test_t039_live_auth.sh` |
| 1 — persisted locale | `bash scripts/test_t103_live_locale.sh` |
| 2 — provisioning/isolation | `bash scripts/test_t041_t044_owned_live.sh` |
| 3 — country/setup validation | `bash scripts/test_t050_live.sh` |
| 3 — setup persistence/handoff | `bash scripts/test_t054_live.sh` |
| 3 — rendered setup browser | `bash scripts/test_t056_live_browser.sh` |
| 4 — module selection | `bash scripts/test_t072_live.sh` |
| 5/6 — billing customer/admin lifecycle | `bash scripts/test_t071_live.sh` |
| 7 — checklist browser/liveness | `bash scripts/test_t080_live_browser.sh` |
| 8 — support access | `US8_EVIDENCE_DIR="$(mktemp -d /tmp/kemfai-us8-evidence.XXXXXX)" bash scripts/test-us8-owned-live.sh` |

T096, T109, T111, and T112 cross-cutting commands are documented in their dedicated sections. Inspect each script's final cleanup assertion or cleanup receipt; exit code zero alone is not sufficient evidence.

## 5. Colour-independent state validation

Every status, warning, and error in the T110 scope must retain an independently legible text label when colour is removed: billing lifecycle, support grants, tenant provisioning, signup/verification, setup, payment-proof upload, module selection, and checklist activation gating.

```bash
cd frontend
npx playwright test tests/e2e/status-text-label-not-colour-only.spec.ts
```

This is separate from axe accessibility tests; passing axe alone does not prove that state is not encoded by colour only.

## 6. Baseline reconciliation

No implementation-time change in T001–T112 alters a locked Gate 0 owner decision:

| Locked baseline | As-built reconciliation |
|---|---|
| Tenant DB — separate DB per customer from launch | Preserved; each tenant receives one Odoo database and control-plane code never queries tenant DBs directly. |
| Billing V1 — manual bank transfer + Billing Admin activation | Preserved; customer proof and internal BillingAdmin review remain the V1 activation path. |
| Billing Phase 2 — Stripe behind KEMFAI Billing Service | Preserved; Stripe/cards are not part of the V1 activation path. |
| Languages — English + Arabic Day 1, full LTR/RTL | Preserved, including RTL and persisted authenticated locale. |
| Country Compliance — versioned country packs following applicable official regulations | Preserved; regulatory logic remains outside the accounting core. |
| Accounting Policies — explicit Accounting Policy Matrix | Preserved for posting, FX, rounding, costing, reversals, period controls, and recognition rules. |

`GATE0_DECISIONS.md` still records Odoo 18 as the current development choice while the owner row remains distinct from the locked decisions above. This guide does not silently promote that dev choice into a new owner lock.

## 7. Validation entry points

Run commands from the repository root unless noted:

```bash
# Static/unit/contract/integration gates
npm --prefix backend/api run lint
npm --prefix backend/api run build
npm --prefix backend/api test -- --runInBand
npm --prefix backend/api run test:contract -- --runInBand
npm --prefix backend/api run test:integration -- --runInBand
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend test -- --ci --runInBand
npm --prefix frontend run build

# Full generic browser suite (provide an isolated Redis exactly as CI does)
(cd frontend && npx playwright test)

# All four Odoo addons (provide a scratch PostgreSQL and KEMFAI_CI_DB_* as CI does)
bash scripts/ci/test_odoo_addons.sh

# Governance and cleanup regressions (includes T096 wiring)
bash scripts/tests/run_all.sh

# Runtime/security and no-exposure gates
bash scripts/test_t096_security_hardening.sh
bash scripts/test_t109_odoo_exposure.sh all
```

The generic Playwright and Odoo commands require their isolated Redis/PostgreSQL prerequisites; `.github/workflows/ci.yml` is the canonical environment definition. T112's owned commands are in the feature-flag section. T096 creates one uniquely named, owner-labelled Keycloak container on a dynamic loopback port and verifies its removal. T109 creates exact-labelled PostgreSQL/Redis containers on dynamic ports, owns its API/Next process groups, writes a cleanup receipt, and verifies no labelled survivor. T111/T112 and the US8 live fixture likewise create exact-owned isolated resources. None of these fixture commands uses or requires stopping the fixed development Compose project; never stop an unrelated stack as fixture cleanup. Never point any fixture at shared or live services. Evidence directories must be absolute and outside the source tree. A successful command is not sufficient if its expected assertions/evidence or cleanup check fails.

GitHub CI (`.github/workflows/ci.yml`) runs on pushes to `main`, `develop`, and `feature/**`, and on pull requests targeting `main` or `develop`. It executes governance, frontend static, backend unit/contract/integration, generic Playwright, accounting invariants, durable handoff, audit linkage, and owned frontend/backend live jobs. T098 is the final full-guide execution task; T097 only reconciles this guide to the committed as-built behavior.
