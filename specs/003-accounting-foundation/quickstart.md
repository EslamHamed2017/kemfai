# KEMFAI Accounting Foundation — Owned-Live Validation Quickstart

**Purpose:** runnable acceptance procedure for Stories 1–3 once the planned implementation files exist. It is not a shared development-stack walkthrough and does not claim the not-yet-implemented proof currently passes.
**Contracts:** [`contracts/openapi.yaml`](contracts/openapi.yaml), [`contracts/README.md`](contracts/README.md)
**Policy state:** Finance Owner approved matrix v1.0 on 2026-11-07; approval does not enable runtime behavior. This guide proves draft/master-data behavior only and must fail if posting becomes reachable before its separately implemented, accepted, and released tranche.

## 1. Prerequisites

- Linux host with Docker Engine/Compose v2, Node 22.22.0, npm, Python 3, OpenSSL, `curl`, and Playwright Chromium.
- Repository dependencies installed with `npm ci` in `backend/api` and `frontend`.
- Images available: pinned PostgreSQL 16, Redis 7, Odoo 18 Community, and Keycloak image used by CI.
- Planned implementation includes:
  - `scripts/test_accounting_foundation_owned_live.sh`
  - `scripts/fixtures/accounting_foundation_validate_evidence.py`
  - `frontend/tests/e2e-live/accounting-foundation.live.spec.ts`
  - `backend/addons/kemfai_accounting` and `backend/addons/kemfai_dimensions`

Do not use `infra/.env`, fixed Compose ports, a shared Keycloak realm, or any existing tenant. The owned script must refuse a non-absolute evidence path, a reused ownership label, or pre-existing labelled resources.

## 2. Static and contract preflight

From repository root:

```bash
set -euo pipefail
NODE_PATH="$(pwd)/backend/api/node_modules" node -e \
  "require('js-yaml').load(require('fs').readFileSync('specs/003-accounting-foundation/contracts/openapi.yaml','utf8'))"

npm --prefix backend/api run lint
npm --prefix backend/api run build
npm --prefix backend/api test -- --runInBand
npm --prefix backend/api run test:contract -- --runInBand --runTestsByPath \
  test/contract/accounting-foundation.contract-spec.ts
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend test -- --ci --runInBand
bash scripts/ci/test_odoo_addons.sh
```

The contract suite must assert that no posting/reversal/opening-post/period-transition route is mounted, not merely that the UI hides controls.

## 3. Run the exact-owned production-path proof

```bash
set -euo pipefail
export KEMFAI_AF_RUN_ID="af-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
export KEMFAI_AF_OWNERSHIP_LABEL="kemfai.accounting-foundation.run=${KEMFAI_AF_RUN_ID}"
export KEMFAI_AF_EVIDENCE_DIR="$(mktemp -d "/tmp/kemfai-af-evidence.${KEMFAI_AF_RUN_ID}.XXXXXX")"

bash scripts/test_accounting_foundation_owned_live.sh all
python3 scripts/fixtures/accounting_foundation_validate_evidence.py \
  "$KEMFAI_AF_EVIDENCE_DIR"
```

For the independently accepted Story 1 checkpoint (T071), run the owned slice and
validate its smaller immutable manifest without weakening the full Stories 1–3 gate:

```bash
bash scripts/test_accounting_foundation_owned_live.sh story-1
python3 scripts/fixtures/accounting_foundation_validate_evidence.py \
  --story-1 "$KEMFAI_AF_EVIDENCE_DIR"
```

The script owns and records every resource before creation and installs traps before the first mutation. It must use the established port-keeper pattern to reserve then release dynamic loopback-only ports for PostgreSQL, Redis, Keycloak, Odoo, NestJS, and Next.js. All containers/networks/volumes use the exact ownership label; all processes start in owned process groups. Secrets go only to a mode-0700 private subdirectory, are redacted from publishable logs, and are deleted during cleanup.

## 4. Required topology and readiness

The fixture creates, from scratch:

1. exact-owned control PostgreSQL and Redis;
2. an exact-owned Keycloak realm/client plus independently authenticated User A and User B, real signed sessions, and owned customer-identity memberships mapping User A only to Tenant A and User B only to Tenant B;
3. exact-owned Odoo 18 Community connected to PostgreSQL;
4. two uniquely named tenant databases (`tenant_a_db`, `tenant_b_db` in the run registry), two distinct control-plane routing/provisioning entries, Company A1 and Company A2 in Tenant A, and Company B1 in Tenant B; both DBs have `kemfai_accounting` and `kemfai_dimensions` installed;
5. deterministic seed resources created through each tenant’s authenticated production path, including a recorded real Tenant-B resource UUID for the isolation attempt;
6. migrated production NestJS build pointed to the control DB/Redis/Odoo;
7. production Next.js build pointed only to NestJS;
8. Playwright Chromium pointed only to Next.js.

Readiness is resource-specific and bounded: stable SQL probes against the control DB and each exact tenant DB independently; Redis `PONG`; Keycloak discovery plus separate token/session issuance for User A and User B; owned identity membership lookup for both subjects; independent registry resolution proving Tenant A→`tenant_a_db` and Tenant B→`tenant_b_db`; Odoo authenticated RPC/addon installed-state/company probes on each exact DB; Nest health; Next HTML; and separate final browser login for each user. The evidence records each route/database/company tuple. Container “running,” one ready tenant, or open TCP alone is not readiness.

## 5. Browser journeys and persisted proof

The live Playwright suite runs every journey through:

```text
real Chromium -> production Next page/BFF -> bearer-authenticated NestJS
-> production accounting service -> real Odoo RPC/ORM -> exact tenant DB
-> tenant audit/receipt + platform audit mirror
```

No route interception, mocked repository, manufactured request context, direct-model-only mutation, or native Odoo UI is permitted.

### Story 1 — COA

- EN/LTR: create two parents and one posting child; verify semantic hierarchy/type/status.
- AR/RTL: reload and verify localized labels, direction, keyboard operation, visible focus, and 200% zoom.
- Try the parent on a draft line; receive line-specific `ACCOUNT_NOT_POSTING` and no ledger movement.
- Deactivate a referenced posting account; existing draft retains label, new selection excludes it, validation becomes stale/invalid.
- Replay create with same idempotency key; same result/one account/one audit outcome. Alter payload under same key; 409.
- Submit stale `If-Match`; receive `412` and leave accepted state unchanged.
- As User A, exercise Company A1 and Company A2 isolation. Separately log in as User B and fetch a real Tenant-B account/draft through the ordinary production path; record its UUID and response fingerprint. Then log in as User A and request that exact Tenant-B UUID through the same authenticated production page/BFF/API path with Company A1 context. Require opaque `404`/non-disclosing denial, no Tenant-B fields, no Tenant-B or Tenant-A mutation, and a denial audit. Never manufacture a tenant UUID/header/context.
- Exercise empty, delayed/loading, and recoverable service-error UI without intercepting the final success path.

### Story 2 — Dimensions

- Record account count, create Project and Cost Center values/rule, save a draft missing each, and verify all line-level errors.
- Complete assignments; retrieve same UUIDs/labels via production path; account count remains unchanged.
- Deactivate a used value; preserve historical draft display, exclude new selection, force revalidation.
- Prove stale rule update, idempotent create, authorization/scope denial, audit failure behavior, empty/loading/error, EN/AR/RTL.

### Story 3 — Journals/currencies/drafts

- Create an active journal; enable one foreign currency for Company A using `If-Match: *`; prove a repeated create precondition fails `412`, an update requires the returned strong ETag, and only `enabled` can change. Prove company base currency, native decimal places, and native metadata version are immutable through this API.
- Save a balanced foreign-currency draft whose every money tuple contains exact strings plus `transactionCurrencyCode`, `transactionPrecision`, `transactionCurrencyMetadataVersion`, `companyBaseCurrencyCode`, `basePrecision`, `baseCurrencyMetadataVersion`, and `currencyConfigurationVersion`; include non-null `rateReference`/`rateEffectiveDate` and dimensions. Read every amount and metadata field back byte-for-value.
- Save an amount with scale beyond native metadata precision and prove save/read preserves it exactly; validation returns `AMOUNT_SCALE_EXCEEDS_METADATA` as a policy blocker, never a save rejection or changed amount.
- Omit each foreign FX field in turn and prove stable `FX_RATE_REFERENCE_REQUIRED` / `FX_RATE_EFFECTIVE_DATE_REQUIRED` issues; prove base-currency lines explicitly round-trip both fields as null. No source/date policy, rate lookup, rate derivation, or base-amount calculation occurs.
- Validate and assert receipt fields (`operationId`, `auditEventId`, `correlationId`, `replayed`), ETag, `status=valid_for_draft` when otherwise valid, `ledgerEffect=none`, exact totals with company base currency/base precision, and exact account/rule/journal/config/native-metadata versions. Include `POLICY_APPROVAL_REQUIRED` for any post-level conclusion.
- Deactivate the journal and disable the company currency configuration; prove new use is blocked while the prior draft remains visible/stale.
- Prove same-key validation replay, altered-key `409`, stale `412`, `422` validation, fail-closed audit failure/zero validation-run survivor, cross-company denial, empty/loading/error, EN/AR/RTL.

### Mandatory no-posting assertions

The fixture must query both exact tenant databases/ORM routes before and after all journeys and prove:

- no posted `account.move`/move line was created by the fixture in either tenant DB;
- no general-ledger balance changed in either tenant DB;
- no `action_post` equivalent was invoked;
- `/v1/accounting/drafts/{id}/post`, reversal, opening-post, and period-transition probes return 404 (not a policy-bearing 403/422 handler);
- `module.accounting_posting` is absent/false;
- every accepted mutation has exactly one tenant operation receipt and audit event, and its platform mirror/dedupe state is complete.

## 6. Failure injection matrix

Run each mutable family with one controlled failure at a time:

| Failure | Required observation |
|---|---|
| role/scope denial | No tenant mutation; opaque response; denial audit persists. |
| stale/mismatched `If-Match` | `412`; winner unchanged; no partial rule/config/draft/validation update. |
| altered payload under used idempotency key | `409`; original receipt/result remains authoritative. |
| lost RPC response after Odoo commit | handoff recovery replays receipt; exactly one mutation/audit. |
| platform audit mirror unavailable | no success response; handoff remains recoverable; authoritative tenant audit exists; recovery reaches audited once. |
| tenant audit/receipt write failure | Odoo transaction rolls back mutation; no success/platform-success audit. |
| browser retry/double submit | one result only. |
| policy pending | drafts remain usable; all posting operations absent. |

## 7. Evidence manifest

`$KEMFAI_AF_EVIDENCE_DIR` must contain publishable, secret-scanned artifacts:

```text
fixture-registry.json                 # run ID, label, image digests, dynamic ports (no secrets)
readiness.json                        # actual-resource probes and bounded timings
playwright.json / playwright-summary.json
api-contract-summary.json
story-1-state.json
story-2-state.json
story-3-state.json
no-ledger-effect.json                 # Story 1 persisted before/after ledger proof
story-3-no-ledger-effect.json         # Story 3 persisted before/after ledger proof
scope-and-authorization.json
audit-and-receipts.json
failure-injection.json
odoo-exposure-scan.json
secret-scan.json
cleanup-receipt.json
```

The validator checks expected test counts/names, zero skipped/unexpected/flaky tests, both exact tenant DB/routing/provisioning records, both authenticated users and disjoint memberships, all three exact company IDs, the real Tenant-B resource fetch followed by User-A opaque denial, exact money/metadata round-trips, conditional FX codes, complete snapshot versions, mutation/audit receipt cardinality, before/after ledger hashes/counts for both DBs, no forbidden route, no raw Odoo exposure, and cleanup facts. HTTP 2xx or screenshots alone never count as financial-state proof.

## 8. Cleanup and zero-survivor contract

Cleanup runs on success, failure, timeout, and signal. It removes only registry-recorded resources bearing the exact label: seeded accounting resources in both tenants, Company A1/A2/B1, both tenant routing/provisioning mappings, both tenant databases, User A/User B and both owned identity memberships, child process groups, containers, network, volumes, control database, temporary realm/client, buckets if created, and private secret files. It must never call an unscoped `docker system prune`, stop the shared Compose project, kill by broad process name, or drop a database not in its registry.

After cleanup, both the script and independent validator assert:

```bash
# These are illustrative assertions performed with the exact run values.
test -z "$(docker ps -aq --filter "label=$KEMFAI_AF_OWNERSHIP_LABEL")"
test -z "$(docker network ls -q --filter "label=$KEMFAI_AF_OWNERSHIP_LABEL")"
test -z "$(docker volume ls -q --filter "label=$KEMFAI_AF_OWNERSHIP_LABEL")"
```

The receipt records every registered resource and removal outcome, including exact absence checks for both tenant DB names, both routing/provisioning rows, both users, both memberships, all three companies, all seeded resource UUIDs, the control DB, realm/client, containers/volumes/network, listeners/processes, bucket where applicable, and private files, with `cleanup_complete=true`. The independent validator queries the remaining control/identity catalogs and PostgreSQL database list after cleanup; a run fails on any survivor—even when all tests passed.

## 9. Policy-gate stop condition

Do not use this guide to accept Stories 4–7. Finance Owner approval of matrix v1.0 and independent review of `posting-addendum.md` satisfy specification gates only. Story 4 still requires a new tests-first executable task graph, implementation, independent review, a separate owned-live posting corpus, and release approval; Stories 5–7 retain their own gates. Never extend this safe Stories 1–3 proof to imply posting acceptance or activation.
