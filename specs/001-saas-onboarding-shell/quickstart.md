# Quickstart: Validating the SaaS Onboarding Shell (Slice 1)

This is a validation/run guide, not an implementation guide. It assumes `tasks.md` (Phase 2) has been executed.
Field-level detail lives in `data-model.md`; request/response shapes live in `contracts/openapi.yaml`;
audit/job signals live in `contracts/events.md`.

## Prerequisites

- Docker Compose stack up: `kemfai-db` (control-plane + per-tenant Postgres), `kemfai-odoo` (base image used
  per-tenant), Keycloak (`kemfai-customers` and `kemfai-internal` realms imported from `infra/keycloak/`),
  MinIO, Redis (BullMQ). Extend `infra/docker/docker-compose.yml` with these services per plan.md's Project
  Structure before running this guide.
- `backend/api` running against `kemfai_control` with at least one seeded `Plan` (published) carrying
  `PlanFeatureEntitlement` rows and a `PlanSetting` (or relying on `EntitlementDefault`).
- `frontend` running with `NEXT_PUBLIC_API_URL` pointed at the running `backend/api`.
- A seeded internal Keycloak user with the Billing Admin role in `kemfai-internal`, for Story 6.

## Scenario walkthroughs (map to spec.md User Stories)

Each walkthrough should be run once in English/LTR and once in Arabic/RTL per FR-014/FR-024, unless noted.

### 1. Plan selection → verified account (Story 1)
1. `GET /public/plans` — confirm the seeded published plan appears with pricing and feature summary.
2. Complete signup in the UI with a plan+cycle selected; confirm no re-entry of the plan is required.
3. Confirm via `backend/api` logs or DB that no `Tenant` row exists yet (Account only, `email_verified=false`).
4. Use the emailed verification link (or the `/accounts/verify-email` contract call with the issued token in a
   dev mailcatcher). Confirm the account becomes verified and a `tenant.provision` job is enqueued.
5. Enroll MFA via the account UI; confirm `account.mfa_enrolled` audit event.
6. Re-attempt signup with the same, now-verified email; confirm generic rejection (no account-existence leak).

**Expected outcome**: verified Account, no Tenant yet at step 3, `account.*` audit events present.

### 2. Automatic provisioning (Story 2)
1. Immediately after step 4 above, poll `GET /tenants/me` — expect `Pending`/`Creating` then `Ready`.
2. Confirm a distinct Odoo database (`kemfai_tenant_<id>`) and MinIO bucket exist.
3. Confirm the verifying Account holds the Workspace Owner role scoped to that tenant only.
4. Cross-tenant probe: with a second verified account/tenant, attempt to read the first tenant's `/tenants/me`
   or `/companies/current/setup` using the second account's token — expect denial +
   `tenant_access.denied_cross_tenant` audit event.
5. Retry `/tenants/me/provisioning-retry` after a `Ready` state — expect a 409 no-op, not a duplicate.

**Expected outcome**: exactly one Tenant/DB/bucket/Company per account; retries are no-ops; cross-tenant reads
are denied and audited. This is the manual walkthrough of the automated tests in plan.md's Test Strategy
("Tenant isolation" and "Idempotency" subsections).

### 3. Company setup wizard (Story 3)
1. Open the wizard; confirm step order and progress indicator.
2. Switch interface language to Arabic mid-wizard with unsaved input on the current step; confirm input is
   preserved and the screen re-renders fully mirrored RTL.
3. Enter an invalid VAT/tax value for the selected country; confirm a field-level, localized block.
4. Complete all steps; confirm `setup_complete=true` and a `company.setup.completed` audit event.
5. Close and reopen the wizard mid-way (before finishing) in a fresh session; confirm resume at first
   incomplete step with prior answers intact.

### 4. Module selection (Story 4)
1. `GET /modules`; confirm plan-included vs upgrade-required modules are visually distinct.
2. Attempt to `PUT /modules/selection` including a feature key outside the plan's entitlements; expect 403 and
   an explanatory upgrade message — repeat as a raw API call bypassing the UI, expect identical denial.
3. Save an entitled subset; confirm immediate reflection in checklist/navigation and a
   `modules.selection.changed` audit event.

### 5 & 6. Manual billing lifecycle (Stories 5–6)
1. As the customer: view `/billing/subscription`, confirm instructions/reference/amount/period.
2. Upload an unsupported file type; expect 422, no submission row created.
3. Upload a valid proof; expect `PendingReview`, and confirm a second submission attempt for the same period is
   blocked (409) until resolved.
4. As Billing Admin: `GET /internal/billing/review-queue`; confirm all required fields are visible.
5. Approve; confirm Subscription becomes `Active`, a `billing.subscription.activated` audit event exists with
   every FR-009 field populated, and a second approve attempt on the same tenant/period returns 409.
6. On a separate submission, use request-more-info twice in a row; confirm both cycles appear individually in
   `status_history` and the customer always sees the latest request.

### 7. Onboarding checklist (Story 7)
1. On a fresh workspace, confirm all four items show incomplete with direct links.
2. Add a customer/bank/product record directly in the tenant (via the relevant later-slice or seed script);
   confirm the checklist reflects completion without a manual checklist mutation.
3. Delete the bank record; confirm the checklist reverts that item to incomplete (SC-010).
4. With Subscription not yet Active, confirm the "first invoice" item indicates the activation gate distinctly
   from setup-readiness (FR-038).

### 8. Support access grant/audit (Story 8)
1. As Workspace Owner, create a grant with an expiry a few minutes out, for the Support role.
2. As an authorized Support-role internal user, access the tenant within the window; confirm a
   `support_access.grant.used` audit event with the action logged.
3. Wait past expiry; attempt access again; confirm denial and a `support_access.grant.denied` event, without
   any manual revocation, within 1 minute of expiry (SC-009) via the scheduled sweep.
4. Revoke a separate, still-active grant early; confirm immediate denial and a `support_access.grant.revoked`
   event.
5. As the owner, view support-access history; confirm every past grant/usage/revocation is visible.

## Automated verification entry points

- `npm run test:contract` in `backend/api` — validates the live BFF against `contracts/openapi.yaml`.
- `npm run test:integration` in `backend/api` — tenant isolation, idempotency, authorization, source-linkage
  suites described in plan.md's Test Strategy.
- `npx playwright test` in `frontend` — EN/AR RTL + accessibility (axe) + empty/error/loading-state suites.
- Odoo addon tests: `odoo-bin --test-enable -i kemfai_tenant_core,kemfai_company_setup,kemfai_module_selection,kemfai_onboarding_checklist --stop-after-init -d <scratch_db>`.

A slice is considered validated when every walkthrough above passes in both EN/LTR and AR/RTL, and all four
automated entry points are green.
