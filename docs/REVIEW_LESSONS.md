# Cross-task review lessons (auto-curated)

Recurring rejection reasons distilled from docs/PROGRESS.md. The executor prompt
injects these on EVERY task so the same class of defect is never re-introduced.
Last curated: 2026-09-28.

- The dependency tree fails the mandatory Security Gate: `npm audit --omit=dev` reports 12 vulnerabilities, including 4 high-severity findings in runtime dependencies (`js-yaml`, `lodash`, and `multer`, transitively through Nest packages). T001 must not be marked complete until these are remediated—or the locked NestJS 10 constraint receives an explicit owner-approved security decision.
- Because the Security Gate fails, marking T001 `[X]` and recording it as completed in `docs/PROGRESS.md` was premature.
- The mandatory Security/Tenant Gate fails: `npm audit --omit=dev` reports one critical and one high runtime vulnerability through Next.js/PostCSS. T002 cannot be accepted until the locked Next.js version conflict is resolved or the owner formally approves a documented exception with effective mitigations.
- `frontend/tsconfig.tsbuildinfo` is an unignored generated build artifact currently included in the untracked working tree and must not be committed.
- `kemfai-frontend` crashes instead of running, so T003’s “all seven services” acceptance criterion fails.
- The test produces a false pass and never verifies frontend health or reachability; marking T003 `[X]` is premature.
- `tenant.account_id` has no foreign key to `account.id`, despite `data-model.md` explicitly requiring `FK → Account (owner)`. The integration test actively hides this defect by creating Tenant rows with nonexistent account UUIDs. This permits orphaned tenant ownership records and violates the binding data model and tenant/data-integrity gate. T008 was therefore marked complete prematurely.
- T009 requires `EntitlementDefault` to be seeded. The migration only defines column defaults and never inserts the singleton row. The test hides this defect by creating the row itself. T009 therefore fails its acceptance criteria, and marking it `[X]` is premature.
- The integration suite is destructive and non-repeatable: `afterEach` deletes the required `entitlement_default` singleton. A second run fails 2 tests and leaves the migrated database without its required default row. Tests must restore/preserve the seeded singleton and pass repeatedly against an already-migrated database.
- **Seed must happen in the migration itself, not rely on column defaults.** The previous attempt
- **Tests must be repeatable against an already-migrated database.** The prev
- The integration test gate fails: 5/5 suites fail, including every new T010 integration test. `CreateEntitlements1789620000000` attempts to recreate `feature_kind_enum` because the database records the earlier migration as `CreateEntitlements1789610000000`. The current migration history is not repeatable against an already-migrated database, directly contradicting the claimed passing repeatability
- `GET /entitlements/me` has no executable authenticated success path: no implemented component assigns the trusted `req.planId`, so the actual application can only return 401. The controller test manufactures `req.planId` and therefore does not prove that the endpoint returns the current tenant’s entitlements or prevents tenant/plan substitution.
- `BearerAuthGuard` verifies only the JWT signature and `RS256`; it does not validate the expected Keycloak issuer or API audience. Any token signed by the realm for another client can be accepted by this API. Add issuer/audience validation and tests rejecting validly signed tokens with the wrong `iss` or `aud`.
- **Controller was missing entirely (round 1).** Added `EntitlementsController` (`GET
- **`req.planId` was never assigned by a trusted component; the controller test manufactured it
- **`BearerAuthGuard` validated only the JWT signature/algorithm, not issuer or audience (round
- The mandatory Test Gate failed: lint has two errors and all 7 T012 integration tests failed.
- `status_history` is ordinary mutable JSONB; nothing enforces the required append-only behavior.
- Tenant isolation is structurally broken: independent foreign keys allow `tenant_id` from tenant A with `subscription_id` belonging to tenant B. The test does not cover this mismatch.
- T012 was marked complete prematurely despite failed gates and unmet acceptance criteria.
- `status_history` is not guaranteed to be a JSON array on INSERT. The validation trigger is `BEFORE UPDATE` only, so scalar/object JSON can be inserted, violating the required “append-only jsonb array” acceptance criterion. Add an INSERT-capable trigger or `CHECK (jsonb_typeof(status_history) = 'array')`, plus a rejection test.
- The mandatory integration test gate is not green in the actual working environment. The claimed 51/51 result could not be reproduced.
- T012 was marked `[X]` prematurely while its acceptance criteria and test gate remain unsatisfied.
- **`status_history` not guaranteed to be a JSON array on INSERT.** The `BEFORE UPDATE` trigger
- The restricted `kemfai_audit_writer` role is not the API/BFF database role. The application still connects through `CONTROL_DB_USER`, while the new code explicitly admits no application module authenticates with the restricted role. Therefore the real API connection can still update/delete `audit_event`, directly failing T014’s acceptance criterion and FR-008.
- The test only proves that an unused test role lacks UPDATE/DELETE privileges; it does not test the application’s configured database identity. It consequently passes while the required production invariant remains absent.
- T014 was marked complete prematurely. The full integration command also failed in the default environment (70 failures), although the correctly configured targeted T014 suite passed.
- The migration embeds the publicly known development password `kemfai_dev_api_pg` and creates a login role with it in every environment ([db-roles.ts](/home/hermesops/kemfai/backend/api/src/database/db-roles.ts:15), [migration](/home/hermesops/kemfai/backend/api/src/database/migrations/1789700000000-CreateAuditEvent.ts:29)). Because migrations are production artifacts, a production database lacking
- The tested `kemfai_api` role is not the API/BFF’s actual database role. Docker configuration still connects the API as `odoo`, which owns the migrated table and can bypass the revocations. `kemfai_api` is created `NOLOGIN` and only temporarily enabled by the test. Therefore T014’s production acceptance criterion is not satisfied, and marking it complete is premature.
- `CONTROL_DB_APP_ROLE` is interpolated directly into migration SQL without safe identifier/literal escaping. A malformed configured role name can break the migration or inject SQL.
- **The tested `kemfai_api` role was not the API/BFF's actual database role (rounds 1, 3, 4).**
- `TenantScopeGuard` only compares explicit `tenantId` values in headers/query/body/path. A Tenant A caller requesting a Tenant B resource by ordinary resource ID is not ownership-checked, so T017’s “any Tenant B resource” acceptance criterion and FR-001/SC-004 are not satisfied.
- `recordOrLogFailure()` swallows audit-write failures and then returns the 403. Therefore the guard can exit without writing `tenant_access.denied_cross_tenant`, directly violating the acceptance criterion. Tests do not cover this failure path.
- Ordinary-resource-ID ownership checks (verdict point 1): new
- Audit write is awaited and fail-closed (verdict point 2): `AuditService.appen
- `RoleGuard` does not enforce Support’s tenant-specific active-grant scope, so an internal Support identity can pass authorization solely by possessing the `Support` realm role.
- `tasks.md` marks T018 complete despite that missing required authorization behavior and missing tests for it.
- The interceptor is never registered in `AppModule` or used by any production endpoint. Only the test-only `ProbeController` applies it, so actual mutating requests receive no idempotency protection.
- The idempotency scope omits `tenantContext.callerTenantId`. Anonymous requests share the global `"anonymous"` scope, allowing one caller to receive another caller’s stored response when key, method, and path collide. This is a tenant/data-isolation risk.
