# Tasks: KEMFAI Slice 2 — Accounting Foundation

**Input**: accepted artifacts in `specs/003-accounting-foundation/`
**Executable scope**: Stories 1–3 only. Approved policy plus independently reviewed Stories 4–7 addenda satisfy T151–T158, but Stories 4–7 remain non-executable until a new reviewed tests-first task graph is commissioned; no runtime implementation or production activation is authorized by these gate records.
**Task syntax**: `[ID] [P?] [USn?] action — Deps: IDs or external gate; AC: deterministic completion condition.`

Every task is intended to be a focused change (normally ≤20 minutes). Tests are authored and observed red before the first product implementation for their story. `[P]` is used only when the task has no unfinished dependency and edits no file edited by another task in the same parallel batch. A story is not accepted until its unconditional required CI check proves the no-interception production path and fail-closed evidence validation.

## Ownership

| Work | Primary | Backup | Reviewer |
|---|---|---|---|
| Tests, evidence, frontend | Claude | GLM-5.2 | Codex |
| Odoo, NestJS, provisioning | GLM-5.2 | Claude | Codex |
| Policy gates | GPT-5.6 Sol | Claude | Codex + Finance Owner where stated |

No implementer reviews their own work.

---

## Phase 1 — Guardrail tests and executable fixture foundation

### Tests first

- [x] T001 Add YAML-load, internal `$ref`, and canonical path/method assertions for `specs/003-accounting-foundation/contracts/openapi.yaml` in `backend/api/test/contract/accounting-foundation.contract-spec.ts` — Deps: none; AC: unresolved refs or path drift fail.
- [x] T002 Add runtime absence tests for posting, reversal, opening-post, approval, and period-transition routes in `backend/api/test/contract/accounting-foundation.contract-spec.ts` — Deps: T001; AC: a mounted forbidden handler fails even if feature-gated.
- [x] T003 [P] Add two-tenant/two-user/A1-A2-B1 ownership-registry tests in `backend/api/test/support/accounting-foundation-live-fixture.spec.ts` — Deps: none; AC: disjoint real memberships, routes, databases, and companies are required.
- [x] T004 [P] Add dynamic-loopback-port, bounded-readiness, trap-before-mutation, redaction, and cleanup tests in `scripts/tests/test_accounting_foundation_owned_live.py` — Deps: none; AC: fixed/shared resources, unbounded waits, broad cleanup, or leaked secrets fail.
- [x] T005 [P] Add fail-closed evidence-manifest tests in `scripts/tests/test_accounting_foundation_evidence.py` — Deps: none; AC: missing/empty/skipped/flaky story, audit, route, DB, no-ledger, failure-injection, or cleanup evidence fails.
- [x] T006 Add CI-structure tests in `scripts/tests/test_accounting_foundation_ci.py` — Deps: T004, T005; AC: opt-in conditions, `continue-on-error`, retry wrappers, mock/interception modes, skipped independent validation, or non-error artifact upload fail.
- [x] T007 Add task-graph/scope/path-production tests in `scripts/tests/test_accounting_foundation_tasks.py` — Deps: T001–T006; AC: missing/nonpreceding deps, cycles, unsafe `[P]`, test-barrier violations, imports/data targets used before creation, install/model-callability before complete model/import/access creation, acceptance without final addon install-or-upgrade, false T149 green status, post-acceptance prerequisites, executable US4–US7 work, or posting implementation fail.

### Fixture and CI implementation

- [x] T008 Implement the exact-owned resource registry and dynamic port reservation in `backend/api/test/support/accounting-foundation-live-fixture.ts` — Deps: T003; AC: every DB, route, identity, membership, company, process group, container, network, volume, realm/client, and private file is registered before creation.
- [x] T009 Implement independent control DB, Redis, Keycloak, Odoo, Nest, Next, and two-tenant readiness probes in `backend/api/test/support/accounting-foundation-live-fixture.ts` — Deps: T008; AC: each routed DB/addon/company and each real user session is bounded and independently proven.
- [x] T010 Implement `preflight|story-1|story-2|story-3|all|cleanup` orchestration in `scripts/test_accounting_foundation_owned_live.sh` — Deps: T004, T009; AC: every exit/signal performs exact-label cleanup and shared state is refused.
- [x] T011 Implement immutable manifest writing, secret scanning, and cleanup receipts in `scripts/test_accounting_foundation_owned_live.sh` — Deps: T010; AC: incomplete evidence or any survivor makes the command nonzero.
- [x] T012 Implement independent fail-closed manifest/state/audit/route/survivor validation in `scripts/fixtures/accounting_foundation_validate_evidence.py` — Deps: T005, T011; AC: validator reads persisted facts, never trusts exit code/screenshots alone, and has no retry/fallback acceptance.
- [x] T013 Implement deterministic graph/scope/path-production validation in `scripts/fixtures/accounting_foundation_validate_tasks.py` — Deps: T007; AC: it enforces sequential IDs, preceding deps, DAG, story test barriers, `[P]`, safe scope, exact path syntax, every import/data target produced before use, install/model-callability only after complete model/import/access creation, final-addon install-or-upgrade in each acceptance ancestry, exactly one T149 status per FR/SC clause, and no green posting/reversal/opening/period criterion; `--traceability-report <path>` writes the same verified statuses deterministically as JSON.
- [x] T014 Register fixture/evidence/CI/task validator tests in `scripts/tests/run_all.sh` — Deps: T006, T012, T013; AC: all four accounting test files always run and zero discovered tests is failure.
- [x] T015 Add an unconditional `accounting-foundation-owned-live` PR job in `.github/workflows/ci.yml` — Deps: T006, T010–T014; AC: the job runs `all`, always runs the independent validator and artifact upload with `if-no-files-found: error`, and contains no opt-in, retry, mock, interception, or `continue-on-error` path.
- [x] T016 Add mandatory static contract, Nest integration, Odoo discovery/tests, frontend unit, and Playwright discovery steps to `accounting-foundation-owned-live` in `.github/workflows/ci.yml` — Deps: T015; AC: any zero/skipped/unexpected/flaky suite fails before evidence can pass.
- [x] T017 Implement read-only PR-gate verification in `scripts/fixtures/accounting_foundation_verify_branch_protection.py` and its test in `scripts/tests/test_accounting_foundation_ci.py` — Deps: T016; AC: when a PR/merge is requested, the validator reads `gh api` output and fails unless exact check `accounting-foundation-owned-live` is required; it never mutates GitHub settings, and absent protection blocks merge pending explicit Owner approval.

---

## Phase 2 — User Story 1: compact chart of accounts plus real parent-line rejection

**Goal**: bilingual parent/posting COA through browser → Next BFF → Nest → routed Odoo ORM → tenant receipt/audit → platform mirror.
**Independent acceptance**: create hierarchy, attempt a parent on a non-posting draft line, receive `ACCOUNT_NOT_POSTING`, and prove DB/audit/no-ledger facts plus isolation, retry, races, recovery, UI, and cleanup.

### Story 1 tests first — all must exist and be observed red before T031

- [x] T018 [US1] Add addon manifest/import/discovery tests for `kemfai_accounting` in `backend/addons/test_discovery.py` — Deps: T017; AC: missing root/models/tests imports or non-discoverable Odoo cases fail red.
- [x] T019 [US1] Add UUID/company/code/hierarchy/node-kind/selection tests in `backend/addons/kemfai_accounting/tests/test_coa.py` — Deps: T018; AC: parent selection and cross-company links are rejected in ORM and tests are red.
- [x] T020 [US1] Add version/deactivation/history/unlink/audit/receipt rollback tests in `backend/addons/kemfai_accounting/tests/test_audit_receipts.py` — Deps: T019; AC: mutation cannot survive tenant receipt/audit failure and tests are red.
- [x] T021 [US1] Add a true two-connection/two-transaction account-version race in `backend/addons/kemfai_accounting/tests/test_coa.py` — Deps: T020; AC: synchronized concurrent updates produce one winner, one stale result, and one version increment.
- [x] T022 [US1] Add a true two-connection/two-transaction same-idempotency-key race in `backend/addons/kemfai_accounting/tests/test_audit_receipts.py` — Deps: T021; AC: synchronized inserts yield one mutation, one receipt/event, and identical replay result.
- [x] T023 [US1] Add minimal non-posting draft-line account-eligibility/no-ledger tests in `backend/addons/kemfai_accounting/tests/test_drafts.py` — Deps: T022; AC: posting child is accepted, parent/inactive/cross-company account is rejected, and no `account.move` is created.
- [x] T024 [US1] Add control-plane accounting-handoff migration/repository race tests in `backend/api/src/modules/accounting/accounting-mutation-handoff.service.spec.ts` — Deps: T023; AC: pending/committed/audited states, fingerprint conflict, concurrent same-key ownership, and lease fields are red.
- [x] T025 [US1] Add lost-response, mirror-outage, lease/backoff, and exactly-once recovery tests in `backend/api/src/modules/accounting/accounting-mutation-recovery.service.spec.ts` — Deps: T024; AC: recovery reaches audited once or remains retryable without returning success; tests are red.
- [x] T026 [US1] Add account, minimal draft, and `/capabilities` OpenAPI/runtime parity tests in `backend/api/test/contract/accounting-foundation.contract-spec.ts` — Deps: T025; AC: auth, permission, headers, ETag, 409/412/422/503, receipt, safe-false capabilities, and no native leak are red.
- [x] T027 [US1] Add real-RPC A1/A2 and Tenant-A/B isolation tests in `backend/api/test/integration/accounting-tenant-isolation.integration-spec.ts` — Deps: T026; AC: User B first creates/fetches a real UUID and User A attempts that exact UUID through ordinary auth with opaque denial.
- [x] T028 [US1] Add real-control-DB/Odoo lost-response, mirror recovery, tenant-audit rollback, version race, and same-key race tests in `backend/api/test/integration/accounting-audit-failure.integration-spec.ts` — Deps: T027; AC: races use two simultaneous HTTP requests and two real Odoo transactions; sequential stale/replay does not satisfy the test.
- [x] T029 [US1] Add EN/AR hierarchy, draft-line parent rejection, keyboard, semantics, empty/loading/error/retry/conflict, axe, and 200%-zoom tests in `frontend/tests/unit/accounting-coa.spec.tsx` — Deps: T028; AC: browser-visible parent rejection is red before UI exists.
- [x] T030 [US1] Add tagged no-interception Story 1 journey in `frontend/tests/e2e-live/accounting-foundation.live.spec.ts` and discovery config in `frontend/tests/e2e-live/playwright.accounting-foundation.config.ts` — Deps: T029; AC: production Next/BFF/API/Odoo path, persisted parent rejection/audit, races, and no-ledger assertions are discovered and red.

### Shared durability, boot, and provisioning required by Story 1

- [x] T031 [US1] Create an install-neutral `kemfai_accounting` package skeleton in `backend/addons/kemfai_accounting/__init__.py`, `__manifest__.py`, `models/__init__.py`, and `tests/__init__.py` — Deps: T018–T030; AC: root/package imports target only files that exist by T031, `models/__init__.py` imports no future model module, `tests/__init__.py` imports only the already-created Story 1 test modules, the manifest declares only existing addon dependencies and no not-yet-created data file, and no placeholder model or install claim is introduced.
- [x] T032 [US1] Add `accounting_mutation_handoff` schema in `backend/api/src/database/migrations/1790000000000-CreateAccountingMutationHandoff.ts` — Deps: T031; AC: scoped-key uniqueness, state constraint, lease/backoff indexes, redacted payload, route/company/actor fields, and reversible down migration pass T024.
- [x] T033 [US1] Add accounting-foundation safe feature seed in `backend/api/src/database/migrations/1790001000000-SeedAccountingFoundationFeatureFlag.ts` — Deps: T032; AC: only `module.accounting_foundation` is seeded; `module.accounting_posting` remains absent/false.
- [x] T034 [US1] Implement handoff persistence in `backend/api/src/modules/accounting/entities/accounting-mutation-handoff.entity.ts` and `backend/api/src/modules/accounting/accounting-mutation-handoff.service.ts` — Deps: T033; AC: true concurrent same-key claims have one owner, changed fingerprint is 409, and no DB transaction spans RPC.
- [x] T035 [US1] Implement platform audit mirror dedupe/linkage in `backend/api/src/modules/accounting/accounting-platform-audit.service.ts` — Deps: T034; AC: success is withheld until deduped mirror exists; pre-domain denials are opaque and persisted.
- [x] T036 [US1] Implement bounded lease recovery in `backend/api/src/modules/accounting/accounting-mutation-recovery.service.ts` — Deps: T035; AC: pending/committed rows replay by operation UUID, back off boundedly, and T025 passes.
- [x] T037 [US1] Register recovery scheduling in `backend/api/src/modules/accounting/accounting-recovery.module.ts` and `backend/api/src/app.module.ts` — Deps: T036; AC: production boot schedules one BullMQ worker, test boot is controllable, and recovery is not request-dependent.
- [x] T038 [US1] Implement immutable UUID/company/node-kind/parent/version fields in `backend/addons/kemfai_accounting/models/account.py` — Deps: T031; AC: unique code/company and same-company acyclic hierarchy hold in ORM once registered.
- [x] T039 [US1] Implement guarded account create/read/update/deactivate/unlink in `backend/addons/kemfai_accounting/services/coa.py` — Deps: T038; AC: row locks make T019/T021 pass once the complete addon is registered and parent nodes remain line-ineligible.
- [x] T040 [US1] Implement same-transaction append-only events in `backend/addons/kemfai_accounting/models/audit_event.py` — Deps: T039; AC: audit failure rolls back domain mutation.
- [x] T041 [US1] Implement immutable operation receipts/replay in `backend/addons/kemfai_accounting/models/mutation_receipt.py` — Deps: T040; AC: T020/T022 pass after complete-addon installation with exactly one result/event under the real race.
- [x] T042 [US1] Implement minimal custom draft/draft-line staging in `backend/addons/kemfai_accounting/models/draft.py` — Deps: T041; AC: exactly one `draft` state, no posting method, and no inheritance/use of `account.move`.
- [x] T043 [US1] Implement draft-line account eligibility in `backend/addons/kemfai_accounting/services/draft_validation.py` — Deps: T042; AC: parent yields stable `ACCOUNT_NOT_POSTING`, posting child succeeds as a draft-line selection, ledger effect is none, and T023 passes after registration.
- [x] T044 [US1] Finalize Story 1 Python/data registration and guarded access in `backend/addons/kemfai_accounting/__init__.py`, `models/__init__.py`, `services/__init__.py`, `__manifest__.py`, and `security/ir.model.access.csv` — Deps: T038–T043; AC: every imported target and every manifest data target exists at T044, all completed Story 1 models/services are discoverable, customer calls use guarded methods only, and no native Odoo customer UI/model surface is granted.
- [x] T045 [US1] Install or upgrade the complete `kemfai_accounting` addon during tenant provisioning in `backend/api/src/integrations/provisioning/tenant-provision.processor.ts` — Deps: T037, T044; AC: new and repaired tenant DBs install/upgrade the finalized Story 1 addon and prove every Story 1 model callable before Ready.
- [x] T046 [US1] Install or upgrade and verify the complete `kemfai_accounting` addon in both live fixture tenant DBs in `backend/api/test/support/accounting-foundation-live-fixture.ts` — Deps: T009, T044, T045; AC: Tenant A and B independently prove installed version, all Story 1 models callable, routed company readiness, and no browser process starts first.
- [x] T047 [US1] Implement routed company/UUID mapping in `backend/api/src/modules/accounting/accounting-odoo-context.service.ts` — Deps: T045, T046; AC: tenant derives only from JWT registry; company UUID is authorized before resource lookup; no Odoo IDs/DB names escape.
- [x] T048 [US1] Implement account/minimal-draft DTOs in `backend/api/src/modules/accounting/dto/account.dto.ts` and `backend/api/src/modules/accounting/dto/draft.dto.ts` — Deps: T047; AC: exact OpenAPI shapes and stable errors validate.
- [x] T049 [US1] Implement permissioned account service through durable handoff in `backend/api/src/modules/accounting/accounts/accounts.service.ts` — Deps: T034–T036, T047–T048; AC: create/update/deactivate wait for audited state and preserve ETag/receipt/replay semantics.
- [x] T050 [US1] Mount account routes in `backend/api/src/modules/accounting/accounts/accounts.controller.ts` — Deps: T049; AC: only documented GET/POST/PATCH routes exist.
- [x] T051 [US1] Implement minimal draft save/read/validate service in `backend/api/src/modules/accounting/drafts/drafts.service.ts` — Deps: T034–T036, T043, T048; AC: parent rejection traverses real RPC, is receipt-bearing/audited, and creates no ledger row.
- [x] T052 [US1] Mount minimal draft routes in `backend/api/src/modules/accounting/drafts/drafts.controller.ts` — Deps: T051; AC: documented save/read/validate only; no post operation.
- [x] T053 [US1] Implement fail-closed `/v1/accounting/capabilities` in `backend/api/src/modules/accounting/capabilities.controller.ts` — Deps: T033, T047; AC: safe availability is scoped and every posting/reversal/opening/period capability is false.
- [x] T054 [US1] Register controllers/providers/entities in `backend/api/src/modules/accounting/accounting.module.ts` — Deps: T050, T052, T053; AC: no policy/posting provider is imported and contract module boots against both fully upgraded fixture DBs.
- [x] T055 [US1] Import `AccountingModule` and `AccountingRecoveryModule` into the actual graph in `backend/api/src/app.module.ts` — Deps: T037, T046, T054; AC: production Nest boot exposes capabilities/accounts/drafts, starts recovery scheduling, and cannot report ready unless the complete addon is ready.
- [x] T056 [US1] Implement authenticated BFF client/error translation in `frontend/src/lib/auth/accounting-bff.ts` — Deps: T055; AC: session, company, locale, correlation, idempotency, If-Match, ETag, and receipt semantics survive; no Odoo knowledge reaches browser.
- [x] T057 [US1] Implement account collection BFF in `frontend/src/app/api/accounting/v1/accounts/route.ts` — Deps: T056; AC: GET/POST use authenticated server calls only.
- [x] T058 [US1] Implement account item BFF in `frontend/src/app/api/accounting/v1/accounts/[accountId]/route.ts` — Deps: T057; AC: GET/PATCH preserve strong ETag and safe retry.
- [x] T059 [US1] Implement draft collection BFF in `frontend/src/app/api/accounting/v1/drafts/route.ts` — Deps: T056; AC: minimal save uses stable idempotency and exact company context.
- [x] T060 [US1] Implement draft item/validate BFF in `frontend/src/app/api/accounting/v1/drafts/[draftId]/route.ts` and `frontend/src/app/api/accounting/v1/drafts/[draftId]/validate/route.ts` — Deps: T059; AC: line-specific parent error and receipts are preserved.
- [x] T061 [US1] Implement COA hierarchy/create/edit/deactivate states in `frontend/src/app/(workspace)/accounting/chart-of-accounts/chart-of-accounts-screen.tsx` — Deps: T058; AC: semantic hierarchy, stale recovery, safe retry, and active filtering work.
- [x] T062 [US1] Mount COA page in `frontend/src/app/(workspace)/accounting/chart-of-accounts/page.tsx` — Deps: T061; AC: workspace route renders through real authenticated data path.
- [x] T063 [US1] Implement minimal draft-line account chooser in `frontend/src/app/(workspace)/accounting/drafts/draft-composer.tsx` — Deps: T060, T062; AC: parent can be deliberately exercised for validation proof but is never represented as posting-eligible.
- [x] T064 [US1] Mount drafts page in `frontend/src/app/(workspace)/accounting/drafts/page.tsx` — Deps: T063; AC: browser can save and validate a non-posting line without any posting control.
- [x] T065 [P] [US1] Add English COA/draft eligibility/states/errors in `frontend/src/locales/en/common.json` — Deps: T064; AC: no raw/fallback key appears.
- [x] T066 [P] [US1] Add equivalent Arabic COA/draft eligibility/states/errors in `frontend/src/locales/ar/common.json` — Deps: T064; AC: RTL meaning and stored values match English.
- [x] T067 [US1] Add focus restoration, announced line errors, semantic hierarchy, visible focus, and 200%-zoom resilience in `frontend/src/app/(workspace)/accounting/chart-of-accounts/chart-of-accounts-screen.tsx` and `frontend/src/app/(workspace)/accounting/drafts/draft-composer.tsx` — Deps: T065, T066; AC: T029 passes in EN/LTR and AR/RTL.
- [x] T068 [US1] Add Story 1 exact DB/account/draft/receipt/audit/mirror/race/isolation/no-ledger evidence capture in `scripts/test_accounting_foundation_owned_live.sh` — Deps: T028, T055, T067; AC: response-only evidence and sequential-only race evidence fail.
- [x] T069 [US1] Add Story 1 persisted-state, parent-rejection, race, recovery, locale, and cleanup validation in `scripts/fixtures/accounting_foundation_validate_evidence.py` — Deps: T068; AC: validator requires one winner/receipt/event, real foreign UUID denial, exact parent error, both DBs, and zero survivors.
- [x] T070 [US1] Run all Story 1 Odoo/contract/integration/unit/browser tests and observe green — Deps: T019–T069; AC: zero failed/skipped/unexpected/flaky and concurrent races execute against real Odoo DB.
- [x] T071 [US1] Run required `accounting-foundation-owned-live` Story 1 acceptance and publish independently validated evidence — Deps: T070; AC: real Chromium→BFF→Nest→Odoo→tenant audit→platform mirror passes, parent rejection is persisted/audited, no ledger moves, and cleanup has zero survivors.

---

## Phase 3 — User Story 2: dimensions and draft-only rules

### Story 2 tests first — all must exist and be observed red before T080

- [x] T072 [US2] Add definition/value ownership, built-in, uniqueness, activity, history, and no-delete tests in `backend/addons/kemfai_dimensions/tests/test_dimensions.py` — Deps: T071; AC: tests are red.
- [x] T073 [US2] Add rule specificity, overlap, version, resolved-version, and true two-transaction version-race tests in `backend/addons/kemfai_dimensions/tests/test_rules.py` — Deps: T072; AC: synchronized race has one winner and one 412-equivalent.
- [x] T074 [US2] Add assignment required/prohibited/inactive/out-of-scope/all-errors/no-ledger tests in `backend/addons/kemfai_accounting/tests/test_drafts.py` — Deps: T073; AC: tests are red and staging remains non-postable.
- [x] T075 [US2] Add a true two-transaction same-key dimension mutation race in `backend/addons/kemfai_accounting/tests/test_audit_receipts.py` — Deps: T074; AC: one mutation/receipt/event and one replay result.
- [x] T076 [US2] Add dimension/rule/minimal-draft contract and real-RPC isolation/audit/race tests in `backend/api/test/contract/accounting-foundation.contract-spec.ts` and `backend/api/test/integration/accounting-live.integration-spec.ts` — Deps: T075; AC: simultaneous HTTP races, A1/A2/Tenant B, account count, receipts, ETags, and ledger none are red.
- [x] T077 [US2] Add selector/rule/draft keyboard, announced-error, inactive-history, empty/loading/error, axe, EN/AR/RTL/zoom tests in `frontend/tests/unit/accounting-dimensions.spec.tsx` — Deps: T076; AC: tests are red.
- [x] T078 [US2] Add tagged no-interception Story 2 persisted browser journey in `frontend/tests/e2e-live/accounting-foundation.live.spec.ts` — Deps: T077; AC: Project/Cost Center omissions, completion, races, stale rule, isolation, audit, and no-ledger path are red.
- [x] T079 [US2] Extend fixture/evidence tests for both-addon installation and Story 2 state in `scripts/tests/test_accounting_foundation_evidence.py` — Deps: T078; AC: missing normalized IDs/rule versions/account-count/no-ledger facts fail red.

### Story 2 implementation

- [x] T080 [US2] Create an install-neutral dimensions package skeleton in `backend/addons/kemfai_dimensions/__init__.py`, `models/__init__.py`, `tests/__init__.py`, and `__manifest__.py` — Deps: T072–T079; AC: root/package imports target only files existing by T080, `models/__init__.py` imports no future model module, `tests/__init__.py` imports only existing Story 2 tests, and the manifest declares no not-yet-created data/security target or premature installability claim.
- [x] T081 [US2] Implement scoped/versioned definitions in `backend/addons/kemfai_dimensions/models/definition.py` — Deps: T080; AC: definition ownership, uniqueness, activity, history, and no-delete cases pass once registered.
- [x] T082 [US2] Implement scoped/versioned values/inactive history in `backend/addons/kemfai_dimensions/models/value.py` — Deps: T081; AC: value ownership, scope, uniqueness, activity, and history cases pass once registered.
- [x] T083 [US2] Implement deterministic rules and row-lock concurrency in `backend/addons/kemfai_dimensions/models/rule.py` — Deps: T082; AC: T073 race, specificity, overlap, and resolved-version cases pass once registered.
- [x] T084 [US2] Implement normalized line assignments in `backend/addons/kemfai_dimensions/models/assignment.py` — Deps: T083; AC: one scoped value/category/line and historical labels persist.
- [x] T085 [US2] Add only locked category-key seed data in `backend/addons/kemfai_dimensions/data/dimension_definition_data.xml` — Deps: T081–T084; AC: entity/branch/department/cost_center/project/salesperson exist with no policy values and every referenced model/field already exists.
- [x] T086 [US2] Finalize dimensions imports, manifest data order, and guarded access in `backend/addons/kemfai_dimensions/__init__.py`, `models/__init__.py`, `__manifest__.py`, and `security/ir.model.access.csv` — Deps: T081–T085; AC: every Python/data target exists at T086, every Story 2 dimensions model is discoverable, seed and access files load after models, guarded RPC is the only customer path, and no native customer UI is exposed.
- [x] T087 [US2] Register the dimensions dependency and existing dimension-aware draft service in `backend/addons/kemfai_accounting/__manifest__.py` and `backend/addons/kemfai_accounting/services/__init__.py` — Deps: T044, T086; AC: all imported targets exist, `kemfai_dimensions` precedes `kemfai_accounting`, integration uses registry models without a circular Python import, and a clean install/upgrade plan resolves deterministically.
- [x] T088 [US2] Install/upgrade `kemfai_dimensions` then `kemfai_accounting` during provisioning in `backend/api/src/integrations/provisioning/tenant-provision.processor.ts` — Deps: T045, T087; AC: new/repaired tenants verify both complete addons and every Story 2 model before Ready.
- [x] T089 [US2] Install/upgrade and verify both complete addons in both live tenant DBs in `backend/api/test/support/accounting-foundation-live-fixture.ts` — Deps: T009, T046, T087, T088; AC: Tenant A and B independently prove installed versions, all Story 1–2 models callable, and routed companies ready before API/browser start.
- [x] T090 [US2] Extend draft validation for normalized required/optional/prohibited rules in `backend/addons/kemfai_accounting/services/draft_validation.py` — Deps: T085, T087, T089; AC: all line issues and exact rule versions return with `ledger_effect=none`.
- [x] T091 [US2] Implement dimension DTOs in `backend/api/src/modules/accounting/dto/dimension.dto.ts` — Deps: T090; AC: OpenAPI and stable codes match.
- [x] T092 [US2] Implement dimension/rule CRUD, scope, ETags, races, receipts, handoff, and audit in `backend/api/src/modules/accounting/dimensions/dimensions.service.ts` — Deps: T034–T036, T091; AC: real concurrent version/key races and audit failure pass.
- [x] T093 [US2] Mount exact dimension/rule routes in `backend/api/src/modules/accounting/dimensions/dimensions.controller.ts` — Deps: T092; AC: no DELETE or policy route exists.
- [x] T094 [US2] Extend draft DTO/service validation snapshots in `backend/api/src/modules/accounting/dto/draft.dto.ts` and `backend/api/src/modules/accounting/drafts/drafts.service.ts` — Deps: T090, T092; AC: assignments/versions round-trip and validation is receipt-bearing.
- [x] T095 [US2] Register dimensions providers/controllers in `backend/api/src/modules/accounting/accounting.module.ts` — Deps: T093, T094; AC: actual AppModule boot exposes full Story 2 contract and no policy service.
- [x] T096 [US2] Implement dimension definition/value/rule BFF routes under `frontend/src/app/api/accounting/v1/dimension-definitions/`, `dimension-values/`, and `dimension-rules/` — Deps: T095; AC: collection/item routes preserve auth/company/ETag/receipt semantics.
- [x] T097 [US2] Implement dimension/rule progressive UI in `frontend/src/app/(workspace)/accounting/dimensions/dimensions-screen.tsx` — Deps: T096; AC: Project and Cost Center values/rules are configurable with all states.
- [x] T098 [US2] Mount dimensions page in `frontend/src/app/(workspace)/accounting/dimensions/page.tsx` — Deps: T097; AC: workspace navigation reaches authenticated page.
- [x] T099 [US2] Extend draft composer with normalized assignments/all-error display in `frontend/src/app/(workspace)/accounting/drafts/draft-composer.tsx` — Deps: T094, T098; AC: omitted categories are announced together and IDs round-trip.
- [x] T100 [P] [US2] Add English dimension/rule/draft-validation strings in `frontend/src/locales/en/common.json` — Deps: T099; AC: no fallback keys.
- [x] T101 [P] [US2] Add equivalent Arabic strings in `frontend/src/locales/ar/common.json` — Deps: T099; AC: RTL semantics match.
- [x] T102 [US2] Add Story 2 exact assignments/rules/races/audit/isolation/account-count/no-ledger capture in `scripts/test_accounting_foundation_owned_live.sh` — Deps: T088–T101; AC: normalized values and unchanged COA/ledger are persisted facts.
- [x] T103 [US2] Add Story 2 fail-closed checks in `scripts/fixtures/accounting_foundation_validate_evidence.py` — Deps: T079, T102; AC: transformed/missing IDs, absent rule versions, sequential-only races, or response-only evidence fail.
- [x] T104 [US2] Run all Story 2 Odoo/contract/integration/unit/browser tests and observe green — Deps: T072–T103; AC: zero failed/skipped/unexpected/flaky and both real races execute.
- [x] T105 [US2] Run required `accounting-foundation-owned-live` Story 2 acceptance and publish independently validated evidence — Deps: T104; AC: production path proves rules/assignments/history/isolation/audit/no-ledger and zero survivors.

---

## Phase 4 — User Story 3: journals, currencies, exact multi-currency drafts

### Story 3 tests first — all must exist and be observed red before T115

- [x] T106 [US3] Add journal ownership/code/activity/version/history and true two-transaction version-race tests in `backend/addons/kemfai_accounting/tests/test_journals_currencies.py` — Deps: T105; AC: tests are red.
- [x] T107 [US3] Add currency enablement, immutable base/native metadata, create-only `*`, exact ETag update, scope, and version-race tests in `backend/addons/kemfai_accounting/tests/test_journals_currencies.py` — Deps: T106; AC: tests are red.
- [x] T108 [US3] Add exact lexeme/scale/snapshots/FX pair-or-null/no-derived-value tests in `backend/addons/kemfai_accounting/tests/test_drafts.py` — Deps: T107; AC: byte-for-value round trip is red.
- [x] T109 [US3] Add totals/scale blocker/stale config/inactive master/audit rollback/zero-move tests in `backend/addons/kemfai_accounting/tests/test_drafts.py` — Deps: T108; AC: result is never `valid_for_post` and tests are red.
- [x] T110 [US3] Add true two-transaction same-key draft-validation race in `backend/addons/kemfai_accounting/tests/test_audit_receipts.py` — Deps: T109; AC: exactly one immutable run/receipt/event and one replay.
- [x] T111 [US3] Add full contract parity and simultaneous real-RPC journal/currency/draft version/key race tests in `backend/api/test/contract/accounting-foundation.contract-spec.ts` and `backend/api/test/integration/accounting-live.integration-spec.ts` — Deps: T110; AC: both DB ledger hashes, immutable metadata, exact amounts, recovery, and forbidden routes are red.
- [x] T112 [US3] Add journal/currency UI state, keyboard, axe, EN/AR/RTL/zoom tests in `frontend/tests/unit/accounting-journals-currencies.spec.tsx` — Deps: T111; AC: tests are red.
- [x] T113 [US3] Add five-line exact amount/FX/disclaimer/all-issue/double-submit/stale tests in `frontend/tests/unit/accounting-drafts.spec.tsx` — Deps: T112; AC: no posting implication and tests are red.
- [x] T114 [US3] Add tagged no-interception Story 3 browser journey and ≤3-minute measurement in `frontend/tests/e2e-live/accounting-foundation.live.spec.ts` — Deps: T113; AC: persisted exact data, races, failure injection, audit, and both-DB no-ledger proof are red.

### Story 3 implementation

- [x] T115 [US3] Implement journal UUID/company/bilingual/activity/version/no-delete fields in `backend/addons/kemfai_accounting/models/journal.py` — Deps: T106–T114; AC: the file defines the journal model without claiming registration or installation and journal ORM/race behavior is ready for discovery.
- [x] T116 [US3] Implement company currency enablement/read-only native metadata in `backend/addons/kemfai_accounting/models/currency_config.py` — Deps: T115; AC: only enabled changes; base/code/precision/native metadata stay immutable, without claiming registration or installation.
- [x] T117 [US3] Extend draft models with exact monetary strings, journal/currency/source/FX/config snapshots in `backend/addons/kemfai_accounting/models/draft.py` — Deps: T116; AC: no float, scale loss, inferred rate, or base calculation.
- [x] T118 [US3] Complete arithmetic/issues/snapshots/immutable validation runs in `backend/addons/kemfai_accounting/services/draft_validation.py` — Deps: T117; AC: stable FX/scale/policy codes, `valid_for_draft|invalid`, and ledger none pass after complete-addon upgrade.
- [x] T119 [US3] Finalize journal/currency/validation imports, security, and discovery in `backend/addons/kemfai_accounting/models/__init__.py`, `services/__init__.py`, `tests/__init__.py`, `__manifest__.py`, and `security/ir.model.access.csv` — Deps: T115–T118; AC: every imported/data target exists at T119, all Story 3 models/tests are discoverable, guarded RPC remains the only customer path, and no installation is claimed yet.
- [x] T120 [US3] Upgrade and readiness-verify the completed Story 3 `kemfai_accounting` addon during production provisioning in `backend/api/src/integrations/provisioning/tenant-provision.processor.ts` — Deps: T088, T119; AC: new and repaired tenants run install-or-upgrade, prove journal/currency/extended-draft models callable and routed-company ready, and cannot become Ready first.
- [x] T121 [US3] Upgrade and readiness-verify the completed Story 3 `kemfai_accounting` addon in both exact-owned fixture tenant DBs via `backend/api/test/support/accounting-foundation-live-fixture.ts` — Deps: T089, T119, T120; AC: Tenant A and B independently prove installed version, journal/currency/extended-draft models callable, and routed-company ready before API/live browser startup.
- [x] T122 [US3] Implement journal/currency DTOs in `backend/api/src/modules/accounting/dto/journal-currency.dto.ts` — Deps: T121; AC: canonical OpenAPI shapes and immutable-field rejection match.
- [x] T123 [US3] Implement journal CRUD/concurrency/receipts/audit/scope in `backend/api/src/modules/accounting/journals-currencies/journals-currencies.service.ts` — Deps: T034–T036, T121–T122; AC: simultaneous version/key race tests pass against upgraded tenant models.
- [x] T124 [US3] Implement currency list/PUT create-only `*` and exact-ETag update in `backend/api/src/modules/accounting/journals-currencies/journals-currencies.service.ts` — Deps: T123; AC: absent/existing/stale preconditions deterministically return 412 and immutable fields cannot change.
- [x] T125 [US3] Mount journal/currency routes in `backend/api/src/modules/accounting/journals-currencies/journals-currencies.controller.ts` — Deps: T124; AC: exact OpenAPI safe verbs only.
- [x] T126 [US3] Complete exact-decimal/conditional-FX DTOs in `backend/api/src/modules/accounting/dto/draft.dto.ts` — Deps: T118, T121; AC: excess scale saves unchanged and missing provenance becomes stable validation issues.
- [x] T127 [US3] Complete full draft persistence/ETags/retry/stale invalidation in `backend/api/src/modules/accounting/drafts/drafts.service.ts` — Deps: T126; AC: exact values/snapshots survive RPC byte-for-value against upgraded models.
- [x] T128 [US3] Implement immutable receipt-bearing validation orchestration in `backend/api/src/modules/accounting/drafts/draft-validation.service.ts` — Deps: T127; AC: replay/race/recovery has one tenant result/receipt/event and audit failure leaves no run.
- [x] T129 [US3] Register journal/currency/full-draft providers in `backend/api/src/modules/accounting/accounting.module.ts` — Deps: T125, T128; AC: actual AppModule boot against both upgraded DBs passes full contract, `/capabilities` remains safe-false, and no policy/posting provider exists.
- [x] T130 [US3] Implement journal collection/item BFF routes under `frontend/src/app/api/accounting/v1/journals/` — Deps: T129; AC: auth/company/ETag/receipt semantics survive.
- [x] T131 [US3] Implement currency collection/item BFF routes under `frontend/src/app/api/accounting/v1/currencies/` — Deps: T129; AC: `If-Match: *`, exact ETag, and immutable metadata survive.
- [x] T132 [US3] Complete draft item/validate BFF routes under `frontend/src/app/api/accounting/v1/drafts/[draftId]/` — Deps: T129; AC: exact decimal strings, snapshots, issues, ETags, and receipts survive.
- [x] T133 [US3] Implement journal/currency screen in `frontend/src/app/(workspace)/accounting/journals-currencies/journals-currencies-screen.tsx` — Deps: T130, T131; AC: active/history/immutable/create-update states pass.
- [x] T134 [US3] Mount journal/currency page in `frontend/src/app/(workspace)/accounting/journals-currencies/page.tsx` — Deps: T133; AC: authenticated workspace route exposes localized empty/loading/error/retry states.
- [x] T135 [US3] Complete five-line header/master/amount/FX flow in `frontend/src/app/(workspace)/accounting/drafts/draft-composer.tsx` — Deps: T132, T134; AC: exact strings and inactive historical selections persist.
- [x] T136 [US3] Add arithmetic-only totals/snapshots/issues/stale state and explicit “not posting” preview in `frontend/src/app/(workspace)/accounting/drafts/draft-composer.tsx` — Deps: T135; AC: no rate, rounding, base amount, tolerance, or posting conclusion is inferred.
- [x] T137 [US3] Add parity-checked English and Arabic journal/currency/full-draft/preview strings in `frontend/src/locales/en/common.json` and `frontend/src/locales/ar/common.json` — Deps: T136; AC: both locale additions stay within one ≤20-minute key set, no fallback appears, AR/RTL preserves exact-value meaning, and ledger effect none is explicit.
- [x] T138 [US3] Add semantic tables, focus/live regions, keyboard flow, and 200%-zoom resilience in `frontend/src/app/(workspace)/accounting/journals-currencies/journals-currencies-screen.tsx` and `frontend/src/app/(workspace)/accounting/drafts/draft-composer.tsx` — Deps: T137; AC: T112/T113 pass.
- [x] T139 [US3] Add both-DB before/after move/line/balance hashes, posting-method probes, flag state, exact amount/snapshot, and race evidence capture in `scripts/test_accounting_foundation_owned_live.sh` — Deps: T111, T121, T129, T138; AC: every mutable safe family has real concurrent version/key races and both upgraded DBs prove zero ledger change.
- [x] T140 [US3] Add fail-closed exact-money/metadata/FX/snapshot/race/recovery/route-absence and native-engine exposure checks in `scripts/fixtures/accounting_foundation_validate_evidence.py` — Deps: T139; AC: transformed/missing values, sequential races, omitted failure injection, posting routes, or any customer-visible native Odoo URL/model/ID/DB/RPC detail fail.
- [x] T141 [US3] Run all Story 3 Odoo/contract/integration/unit/browser tests and observe green — Deps: T106–T140; AC: zero failed/skipped/unexpected/flaky; final-addon upgrade/readiness, real races, recovery, and both-DB ledger proofs execute.
- [x] T142 [US3] Run required `accounting-foundation-owned-live` Story 3 acceptance and publish independently validated evidence — Deps: T141; AC: production path uses both fully upgraded tenant DBs and passes EN/AR, exact amounts, ≤3-minute five-line draft flow, safe capabilities, no forbidden routes/ledger movement, and zero survivors.

---

## Phase 5 — Final safe-tranche deterministic gates (no new prerequisite implementation)

- [x] T143 Run `python3 scripts/fixtures/accounting_foundation_validate_tasks.py specs/003-accounting-foundation/tasks.md` — Deps: T142; AC: exact sequential IDs, preceding deps, DAG, test barriers, path-production-before-use, complete-addon install/upgrade ancestry, acceptance closure, T149 safe/partial/blocked honesty, race/CI/scope/path checks pass.
- [x] T144 Run OpenAPI load/parity and forbidden-operation scans from `specs/003-accounting-foundation/quickstart.md` — Deps: T143; AC: all documented safe paths including `/capabilities` match runtime and forbidden paths are 404.
- [x] T145 Run Nest lint/build/unit/contract/integration and migration up/down checks from `specs/003-accounting-foundation/quickstart.md` — Deps: T144; AC: green with zero skipped/unexpected/flaky.
- [x] T146 Run Odoo discovery/install/upgrade/model tests through `scripts/ci/test_odoo_addons.sh` — Deps: T145; AC: both new addons execute nonzero real Odoo tests in disposable DBs and cleanup succeeds.
- [x] T147 Run frontend lint/typecheck/unit/build and discovered Playwright accounting config — Deps: T146; AC: green in EN/AR with zero skipped/unexpected/flaky.
- [x] T148 Run `bash scripts/test_accounting_foundation_owned_live.sh all` and independent evidence validation — Deps: T147; AC: Stories 1–3 pass together without interception/retry/mock/continue-on-error and cleanup has zero survivors.
- [x] T149 Run `python3 scripts/fixtures/accounting_foundation_validate_tasks.py specs/003-accounting-foundation/tasks.md --traceability-report "$KEMFAI_AF_EVIDENCE_DIR/traceability-status.json"` to generate and verify clause-level FR-001–FR-050 and SC-001–SC-015 status evidence — Deps: T148; AC: the report contains every clause exactly once with one status (`SAFE-PROVEN`, `PARTIAL-SAFE-ONLY`, or `BLOCKED-POLICY`) plus explicit evidence/limitation; only `SAFE-PROVEN` clauses may be accepted by this tranche, partial/blocked clauses remain non-green, and validation fails if posting, reversal, opening, period-control, all-seven-story, or successful-post/source-traversal criteria are represented as fully accepted.
- [x] T150 Run `git diff --check` and inspect scope with `git diff -- specs/003-accounting-foundation/tasks.md` — Deps: T149; AC: whitespace is clean, only intended task graph changes are present, and no commit is created by this task.

---

## Phase 6 — BLOCKED future tranche: gate records only

These are completed, non-executable gate records. T151 records the approved matrix and T152–T158 record independently reviewed policy verification/addenda. They authorize no route, model, service, UI, test acceptance claim, posting behavior, feature enablement, runtime implementation, or production activation. Any executable Stories 4–7 work requires a new independently reviewed tests-first task graph.

### User Story 4 — posting (BLOCKED)

- [x] T151 [US4] **BLOCKED GATE** Verify Finance Owner approval of all seven matrix categories with version/approver/time/scope/effective date in `specs/003-accounting-foundation/accounting-policy-matrix.md` — Deps: external Finance Owner approval; AC: any pending/missing value keeps US4 blocked.
- [x] T152 [US4] **BLOCKED GATE** Commission separately reviewed posting contract/model/live-proof addendum under `specs/003-accounting-foundation/` — Deps: T151; AC: atomic balance, human authorization, exact matrix version, period evaluation, retry/race, audit/source, release flag, and cleanup are specified before executable tasks exist.

### User Story 5 — reversal/correction (BLOCKED)

- [x] T153 [US5] **BLOCKED GATE** Verify approved reversal date/journal/approval/duplicate semantics in the matrix — Deps: T151; AC: any unresolved behavior keeps US5 blocked.
- [x] T154 [US5] **BLOCKED GATE** Commission separately reviewed reversal contract/model/live corpus — Deps: T152, T153; AC: immutable original, equal-opposite linkage, currencies, dimensions, periods, retry/race, audit, and cleanup are specified first.

### User Story 6 — opening balances (BLOCKED)

- [x] T155 [US6] **BLOCKED GATE** Verify applicable posting/FX/rounding/period values in the matrix — Deps: T151; AC: any unresolved value keeps US6 blocked.
- [x] T156 [US6] **BLOCKED GATE** Commission separately reviewed Prepare→Validate→Preview→Approve→Post addendum — Deps: T152, T155; AC: cutoff/source/control totals/correction/permissions/retry/race/audit/cleanup are specified first.

### User Story 7 — periods (BLOCKED)

- [x] T157 [US7] **BLOCKED GATE** Verify approved action table and reopening semantics for the four locked period states — Deps: T151; AC: no permission/action is inferred and unresolved behavior keeps US7 blocked.
- [x] T158 [US7] **BLOCKED GATE** Commission separately reviewed period contract/model/live corpus — Deps: T152, T157; AC: effective time, matrix lookup, immutable history, authorization, reason, concurrency, audit, and cleanup are specified first.

---

## Dependencies and parallel execution

- Main executable chain: foundation `T001–T017` → Story 1 tests `T018–T030` → Story 1 implementation/acceptance `T031–T071` → Story 2 tests `T072–T079` → implementation/acceptance `T080–T105` → Story 3 tests `T106–T114` → build/register/upgrade/API/UI/acceptance `T115–T142` → deterministic gates `T143–T150`.
- Story first-implementation barriers are exact: `T031` depends on every US1 test task; `T080` depends on every US2 test task; `T115` depends on every US3 test task. Skeletons at T031/T080 import only already-existing targets; model registration and installability are deliberately deferred. Each test task requires an observed-red AC.
- Story acceptance closure is exact: `T071`, `T105`, and `T142` transitively include complete-addon imports/access plus final install-or-upgrade, production provisioning, live fixture install/readiness, migrations/repository, audit mirror/recovery scheduling, actual `AppModule` registration, `/capabilities`, BFF/page routes, test discovery, required CI, evidence validation, and real races.
- No product implementation occurs after its story acceptance. `T143–T150` only rerun/inspect already-complete behavior.
- `[P]` batches are limited to `T003–T005`, `T065–T066`, and `T100–T101`; each pair/group uses distinct files and begins only after its stated dependency. Tasks sharing contract specs, live specs, services, screens, locale files across stories, workflow, fixture, validator, manifests/imports, or addon tests are deliberately serialized.
- Required merge check `accounting-foundation-owned-live` is unconditional from `T015`, structurally tested by `T006`, and fail-closed verified read-only by `T017`. Story acceptance can use a story selector, but no Story 1–3 implementation PR may merge unless that exact check is externally required and green; changing GitHub protection remains an explicit Owner-approved action.
- T151–T158 are blocked records, excluded from executable DAG acceptance and from parallel implementation.

## Traceability

T149 treats status as data, not prose: only `SAFE-PROVEN` is green in the safe tranche. `PARTIAL-SAFE-ONLY` proves only the stated non-policy subset and remains non-green for the full clause; `BLOCKED-POLICY` has no executable acceptance claim. The validator must reject a missing/duplicate clause, an unknown status, or evidence language that upgrades a partial/blocked clause.

| Clause | Status | Executable evidence or blocked gate | Exact accepted boundary / limitation |
|---|---|---|---|
| FR-001 | **SAFE-PROVEN** | T019–T028, T038–T055, T071; T072–T142 | All records created by the safe tranche use immutable UUID and tenant/company scope; no intercompany or posted-entry claim. |
| FR-002 | **SAFE-PROVEN** | T020, T027–T028, T035, T047, T068–T071; T076–T105; T111–T142 | Opaque denial and denial audit are proven for executable records in both tenant DBs. |
| FR-003 | **PARTIAL-SAFE-ONLY** | T026–T030, T047–T071; T076–T105; T111–T142 | View/Create/Edit and company/dimension scopes are proven; Post/Approve/Reverse and complete Export/amount-scope enforcement are not accepted. |
| FR-004 | **PARTIAL-SAFE-ONLY** | T002, T026, T053–T055, T111, T127–T148 | Forbidden final-action routes and capabilities are safe-false; no positive human posting/approval/reversal/period action exists. |
| FR-005 | **SAFE-PROVEN** | T029–T030, T061–T071; T077–T105; T112–T142 | All customer-facing Stories 1–3 safe surfaces and audit descriptions are proven EN/LTR and AR/RTL; blocked workflows expose no UI. |
| FR-006 | **SAFE-PROVEN** | T029–T030, T061–T071; T077–T105; T112–T142 | Every executable in-scope UI proves keyboard, focus, names/errors/status, states, and 200% zoom. |
| FR-007 | **SAFE-PROVEN** | T026–T030, T047–T071; T076–T105; T111–T142 | Safe workflows use KEMFAI surfaces and native-engine leakage scans fail closed. |
| FR-008 | **PARTIAL-SAFE-ONLY** | T023, T029–T030, T038–T046, T051–T071 | Parent/posting kinds and `ACCOUNT_NOT_POSTING` are proven on a real draft line with zero ledger effect; an actual post attempt is blocked. |
| FR-009 | **SAFE-PROVEN** | T019, T038–T046, T068–T071 | Cycle prevention and stable account references are proven in ORM and live acceptance. |
| FR-010 | **PARTIAL-SAFE-ONLY** | T019–T020, T038–T046, T049–T071 | Deactivation/no-delete/history behavior is proven for safe references; preservation against real posted history awaits posting policy. |
| FR-011 | **SAFE-PROVEN** | T072–T105 | Dimension analysis is normalized and account-count invariance is persisted. |
| FR-012 | **PARTIAL-SAFE-ONLY** | T072, T080–T105 | Locked built-in categories are proven; configurable custom dimensions/tags are not claimed green without explicit acceptance evidence. |
| FR-013 | **SAFE-PROVEN** | T073, T076–T105 | Data-driven account/transaction/company applicability and effective/versioned draft rules are proven. |
| FR-014 | **PARTIAL-SAFE-ONLY** | T074, T076–T105 | All missing/inactive/out-of-scope issues are proven at draft lines; posting validation remains blocked. |
| FR-015 | **BLOCKED-POLICY** | T151–T154 | Matrix v1.0 and the reviewed posting/reversal addenda specify the policy boundary, but posted dimension propagation, reversal copying, and correction lineage have no executable implementation or acceptance. |
| FR-016 | **PARTIAL-SAFE-ONLY** | T106–T142 | Company-authorized journal and inactive-master behavior are proven for drafts; posted-entry behavior is blocked. |
| FR-017 | **PARTIAL-SAFE-ONLY** | T107–T142 | Exact transaction lexemes, currency/precision, supplied FX provenance, and snapshots are preserved in drafts; no policy-derived base amount or posted result is claimed. |
| FR-018 | **PARTIAL-SAFE-ONLY** | T106–T142 | Company-scoped auditable journal/currency configuration and draft history are proven; non-destruction against posted history is blocked. |
| FR-019 | **SAFE-PROVEN** | T107–T142 | Byte-for-value amount/currency/rate/account/dimension persistence is proven across EN/AR and RTL. |
| FR-020 | **SAFE-PROVEN** | T023, T029–T071; T074–T105; T108–T142 | Authorized draft create/revise/validate is proven with unchanged ledger hashes. |
| FR-021 | **BLOCKED-POLICY** | T151–T152 | No post operation exists; balance, period, policy, and final posting validation are not accepted. |
| FR-022 | **BLOCKED-POLICY** | T151–T152 | Atomic posted entry/source/policy/audit outcome requires the posting addendum. |
| FR-023 | **BLOCKED-POLICY** | T151–T152 | Safe mutations prove idempotency, but this clause specifically requires posting idempotency and therefore is not green. |
| FR-024 | **BLOCKED-POLICY** | T151–T152 | No posted entries exist from which immutability can be accepted. |
| FR-025 | **BLOCKED-POLICY** | T151–T154 | Positive posted entry/source/reversal/correction traversal is not implemented or accepted. |
| FR-026 | **SAFE-PROVEN** | T023, T029–T071; T074–T105; T108–T142 | Draft validation returns all actionable line/entry issues, preserves drafts, and proves zero ledger effect. |
| FR-027 | **PARTIAL-SAFE-ONLY** | T020, T025, T028, T034–T071; T075–T105; T110–T142 | Fail-closed audit persistence is proven for safe master/draft mutations; posting/reversal/opening/period changes remain blocked. |
| FR-028 | **SAFE-PROVEN** | T002, T026, T033, T053–T055, T111, T127–T148, T151–T158 | Posting flag/capability/route/method probes prove production posting remains disabled despite approved matrix v1.0 and reviewed future-work addenda. |
| FR-029 | **BLOCKED-POLICY** | T151–T152 | Matrix v1.0 is approved and retention is specified by the reviewed posting addendum, but no posted-entry implementation or acceptance proves runtime retention. |
| FR-030 | **BLOCKED-POLICY** | T151–T154 | Matrix v1.0 and the reviewed reversal addendum specify behavior and permissions, but no reversal/correction implementation or acceptance exists. |
| FR-031 | **BLOCKED-POLICY** | T153–T154 | Approved reversal semantics are specified, but equal-and-opposite currencies/source/dimensions have no executable implementation or acceptance. |
| FR-032 | **BLOCKED-POLICY** | T153–T154 | Reversal atomicity/idempotency/duplicate prevention have no executable workflow. |
| FR-033 | **BLOCKED-POLICY** | T151–T152, T155–T156 | Approved policy and the reviewed opening addendum specify Prepare→Validate→Preview→Approve→Post, but no executable implementation or acceptance exists. |
| FR-034 | **BLOCKED-POLICY** | T155–T156 | Opening batch company/cutoff/source/control-total behavior is not implemented. |
| FR-035 | **BLOCKED-POLICY** | T153–T156 | Posted opening immutability and linked correction require opening and reversal policy. |
| FR-036 | **BLOCKED-POLICY** | T151–T152, T157–T158 | The approved action table and reviewed period addendum exist, but positive period states/transitions/reopening have no executable implementation or acceptance. |
| FR-037 | **BLOCKED-POLICY** | T151–T158 | Execution-time period/matrix rules are specified, but posting/reversal/period implementations and production-path acceptance are absent. |
| FR-038 | **BLOCKED-POLICY** | T157–T158 | No positive period transition/history workflow is accepted. |
| FR-039 | **PARTIAL-SAFE-ONLY** | T020, T028, T035, T040–T071; T072–T105; T106–T142 | Complete append-only fields are proven for safe master/draft actions and denials; policy approvals and blocked financial actions are absent. |
| FR-040 | **BLOCKED-POLICY** | T151–T154 | Draft source snapshots do not satisfy positive source↔posted-entry↔audit traversal. |
| FR-041 | **SAFE-PROVEN** | T151 | Approved matrix v1.0 records version, approver, timestamp, global scope with Country Pack applicability, effective date, and amendment/history requirements. |
| FR-042 | **SAFE-PROVEN** | T151 | Finance Owner approval resolves all seven locked categories in matrix v1.0; approval alone does not enable any production workflow. |
| FR-043 | **BLOCKED-POLICY** | T151–T152 | Matrix v1.0 and revalidation semantics exist, but no posting implementation proves execution-time applicability or supersession handling. |
| FR-044 | **BLOCKED-POLICY** | T151–T158 | Safe code proves it does not infer policy and matrix/addenda define future boundaries, but configurable policy-dependent runtimes have no implementation acceptance. |
| FR-045 | **SAFE-PROVEN** | T002, T026, T033, T053–T055, T071, T105, T111, T127, T138–T148 | Blocked workflows are inaccessible and safe draft/master-data workflows remain usable. |
| FR-046 | **PARTIAL-SAFE-ONLY** | T030, T046, T068–T071; T078–T105; T114, T121, T139–T148 | Stories 1–3 traverse the full production boundary and exact DBs; Stories 4–7 have no acceptance journey. |
| FR-047 | **SAFE-PROVEN** | T003–T017, T027–T030, T068–T071; T076–T105; T111–T148 | Final safe-story acceptance rejects mocks, interception, manufactured scope, and direct-model-only substitutes. |
| FR-048 | **SAFE-PROVEN** | T003–T017, T046, T071, T089, T105, T121, T142, T148 | Every live safe-story run proves exact ownership, dynamic ports, readiness, bounds, redaction, receipts, cleanup, and zero survivors. |
| FR-049 | **PARTIAL-SAFE-ONLY** | T021–T028, T034–T071; T073–T105; T106–T142 | Concurrent/stale/retry behavior is proven for every mutable safe workflow; blocked posting/reversal/opening/period workflows are not claimed. |
| FR-050 | **PARTIAL-SAFE-ONLY** | T020–T028, T035, T040–T071; T072–T105; T106–T148 | Persisted tenant/company state and audit are proven for safe mutations; positive posted source/policy linkage is blocked. |
| SC-001 | **PARTIAL-SAFE-ONLY** | T023, T027–T030, T046, T068–T071; T074–T105; T108–T148 | Parent draft-line, scope, dimension, inactive-master, and zero-ledger cases are proven; unbalanced-post and disallowed-period post attempts do not exist. |
| SC-002 | **BLOCKED-POLICY** | T151–T152 | There are no successfully posted entries; exact posted balance cannot be marked green. |
| SC-003 | **BLOCKED-POLICY** | T151–T154 | The required corpus of 100 posting/reversal replays cannot run before those workflows exist. |
| SC-004 | **SAFE-PROVEN** | T027–T030, T068–T071; T076–T105; T111–T142 | Real foreign UUID/company attempts prove 100% opaque denial in the safe acceptance corpus. |
| SC-005 | **BLOCKED-POLICY** | T151–T154 | Successful posted-entry traversal to source, policy, dimensions, audit, and reversal/correction is absent. |
| SC-006 | **BLOCKED-POLICY** | T153–T154 | No successful reversal corpus exists. |
| SC-007 | **PARTIAL-SAFE-ONLY** | T113–T114, T121, T132–T142 | A five-line draft can be created, validated, and submitted for safe validation within ≤3 minutes in EN/AR; posting/approval submission is not claimed. |
| SC-008 | **PARTIAL-SAFE-ONLY** | T029–T071; T077–T105; T112–T142 | Three safe story journeys pass EN/AR, keyboard, RTL, and 200% zoom; all seven cannot pass while US4–US7 are blocked. |
| SC-009 | **SAFE-PROVEN** | T029–T071; T077–T105; T112–T142 | All executable screens prove localized states and duplicate-free retries. |
| SC-010 | **SAFE-PROVEN** | T072–T105 | Persisted account-count evidence proves analysis uses dimensions without account proliferation. |
| SC-011 | **PARTIAL-SAFE-ONLY** | T020, T028, T035, T040–T071; T072–T105; T106–T142 | Safe account/dimension/journal/currency changes and denials have complete audit fields; posts/reversals/openings/period transitions/policy approvals are blocked. |
| SC-012 | **SAFE-PROVEN** | T033, T053–T055, T111, T127–T151 | Matrix v1.0 is Owner-approved and applicable; scans prove safe code supplies no unresolved value and production posting remains disabled pending implementation and release gates. |
| SC-013 | **PARTIAL-SAFE-ONLY** | T030, T046, T071; T078, T089, T105; T114, T121, T142, T148 | Three safe journeys pass the real boundary; all seven do not. |
| SC-014 | **SAFE-PROVEN** | T003–T017, T071, T105, T142, T148 | Every live safe acceptance publishes ownership/cleanup receipts and proves zero survivors/shared mutation. |
| SC-015 | **PARTIAL-SAFE-ONLY** | T021–T028, T034–T071; T073–T105; T106–T142 | Concurrent/stale, retry, and audit-failure cases are proven for every mutable safe workflow; blocked workflows are not accepted. |

**Safe-tranche final gate**: T149 may accept only rows marked `SAFE-PROVEN`; it must report every `PARTIAL-SAFE-ONLY` and `BLOCKED-POLICY` row as non-green, prove forbidden posting/reversal/opening/period routes and capabilities remain absent, and fail if any successful posted entry, successful reversal, positive opening/period action, all-seven-story pass, or posted source traversal is claimed. Matrix approval evidence is permitted but cannot upgrade an unimplemented runtime criterion.

## Deterministic validation contract

Run from repository root after implementation:

```bash
set -euo pipefail
python3 scripts/fixtures/accounting_foundation_validate_tasks.py \
  specs/003-accounting-foundation/tasks.md
NODE_PATH="$(pwd)/backend/api/node_modules" node -e \
  "require('js-yaml').load(require('fs').readFileSync('specs/003-accounting-foundation/contracts/openapi.yaml','utf8'))"
npm --prefix backend/api run lint
npm --prefix backend/api run build
npm --prefix backend/api test -- --runInBand
npm --prefix backend/api run test:contract -- --runInBand --runTestsByPath \
  test/contract/accounting-foundation.contract-spec.ts
npm --prefix backend/api run test:integration -- --runInBand
bash scripts/ci/test_odoo_addons.sh
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend test -- --ci --runInBand
npm --prefix frontend run build
npx --prefix frontend playwright test \
  --config tests/e2e-live/playwright.accounting-foundation.config.ts
bash scripts/test_accounting_foundation_owned_live.sh all
python3 scripts/fixtures/accounting_foundation_validate_evidence.py \
  "$KEMFAI_AF_EVIDENCE_DIR"
git diff --check
```

Validators and CI must fail closed: no retries, route interception, mocks, skipped/unexpected/flaky tests, `continue-on-error`, missing evidence, response-only proof, or survivor tolerance.

## Guardrails

- No Story 1–3 code may call or expose `action_post`, create a posted `account.move`, implement reversal/opening/period actions, infer FX/rounding policy, or enable `module.accounting_posting`.
- Exact decimal lexemes and metadata snapshots are preserved; validation may report policy blockers but never transform values.
- Tenant context is JWT/registry-derived; company/resource ownership is checked before disclosure; public IDs are UUIDs.
- Odoo tenant transaction owns authoritative receipt/audit; control plane owns only handoff/platform mirror metadata.
- Acceptance is the exact real browser→BFF→Nest→Odoo ORM→tenant DB→audit path with independently validated persisted evidence and exact-owned cleanup.
