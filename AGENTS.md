# KEMFAI - Agent Execution Protocol

This file is the operating contract for any AI agent working on KEMFAI.

## Baseline documents
1. docs/KEMFAI_Blueprint_v1.0.pdf (or .txt)
2. docs/KEMFAI_Implementation_Spec_v1.1_FINAL.pdf (or .txt)

Treat both as the single source of truth. Do not invent product, UX or accounting
rules that contradict them. If ambiguous, raise a Decision Request; do not guess.

## Agent roles and responsibilities

| Agent | Role | Primary responsibility |
|-------|------|------------------------|
| Hermes | Orchestrator | Backlog, dependencies, task routing, review flow, status. Does NOT make product/accounting decisions. |
| GPT-5.6 Sol (Codex acct) | Product/Finance | Product, finance, accounting and architecture decisions. Material changes require owner approval. |
| Claude | Spec + Frontend | speckit artifacts, Next.js UI, complex integration. Primary spec author. |
| GLM-5.2 | Backend builder | Odoo backend, APIs, CRUD, migrations, repetitive implementation. |
| Codex | Reviewer | Code review, automated tests, security/code audit, final acceptance. |
| Gemini | Cross-check | Consistency across Constitution/Spec/Plan/Tasks, docs, UI review. |

## SpecKit pipeline (mandatory)
1. Product Baseline - GPT-5.6 Sol
2. speckit.constitution - Claude
3. speckit.specify - Claude
4. speckit.clarify - Claude + GPT-5.6 Sol
5. speckit.plan - Claude
6. speckit.tasks - Claude (Task ID, deps, ACs, Primary/Backup/Reviewer)
7. speckit.analyze - Gemini + Claude (consistency)
8. speckit.implement - GLM + Claude Code
9. Continuous Review - Codex
10. Final Acceptance - Codex (+ Gemini UI/cross-module)

Core Rule: NO SPEC -> NO TASK ID -> NO IMPLEMENTATION -> NO TEST -> NO MERGE.

## No-blocker rules
1. Every important task has Primary + Backup + Reviewer.
2. No model is a single point of failure. If Primary fails, Hermes reassigns to Backup.
3. Frontend, backend, tests and localization run in parallel wherever deps allow.
4. A pending review blocks only the dependent task, not unrelated work.
5. Ambiguity -> Decision Request; unaffected work continues.
6. No model approves its own implementation.
7. Main branch must remain runnable; merges require automated tests.
8. Tasks are small independently deliverable vertical slices.
9. Accounting integrity, tenant isolation, tax, payments, posting and security are mandatory gates.
10. Hermes continuously chooses ready non-blocked tasks so work keeps moving.

## Quality gates (cannot be bypassed for speed)
Spec Gate -> Accounting/Data Gate -> Test Gate -> Security/Tenant Gate -> Acceptance Gate.

## Implementation contract (Spec section 25)
- Vertical slices end-to-end: UI -> API/BFF -> domain -> Odoo/posting -> audit -> tests.
- Every story defines: permissions, tenant/company scope, audit events, empty/error/loading states, accessibility.
- Every financial feature defines: posting behavior, reversals, multi-currency, dimension propagation.
- Every KPI/report documents: calculation logic + drill-down target.
- No plan/tax/approval/localization rule hard-coded when configuration is appropriate.
- Automated tests cover: debits=credits, tenant isolation, authorization, idempotency, source linkage.
- Feature flags for incomplete modules - no partial financial workflows in production.

## Branch and merge rules
- main - always runnable, protected, requires PR + review + green CI.
- develop - integration branch.
- feature/<slice>-<desc> - per vertical slice.
- All merges via PR with Codex review + Gemini cross-check where applicable.
- Owner (Islam / eslam.berkawy@gmail.com) approves any change to locked baseline decisions.

## Durable Claude<->Codex technical-resolution loop (scripts/run_loop.sh)

The autonomous runner (`scripts/run_next_step.sh`, orchestrated by
`scripts/run_loop.sh` on a cron fire) never stops for owner attention over
ordinary **technical/architecture/schema/API/localization/migration/test**
ambiguity. Current task identity, rejection feedback, and arbiter
resolutions persist in `scripts/.state/` across ticks so the SAME task
resumes automatically on the next fire.

Executor output contract (implement stage, machine-parsed):
- First line, exactly: `KEMFAI_TASK_ID: T###` or `KEMFAI_TASK_ID: NONE`.
- Ordinary technical ambiguity: the executor decides it itself and proceeds
  — no stop. If it truly cannot proceed safely, it adds one line elsewhere:
  `KEMFAI_TECH_QUESTION: <concrete question>`.
- Only for a material product scope/behavior change, accounting/tax policy,
  legal/compliance exposure, or a **locked baseline** change does it add:
  `KEMFAI_OWNER_ESCALATION: <one-line summary>` — this is the only marker
  that stops the loop for real owner attention. A legacy/plain "Decision
  Request" (the older pattern this file and the constitution still
  document) is also recognized and intercepted even without
  `KEMFAI_TECH_QUESTION`.

Resolution flow, keyed strictly per Task ID (never inherited across a
different or unknown task id):
1. Codex review REJECT, or an executor `KEMFAI_TECH_QUESTION` -> exact
   blockers/question are fed back to Claude for the SAME task and retried.
2. After `ARBITER_AFTER` (default 2) setbacks on the SAME task, Codex is
   invoked as independent **technical arbiter** (`scripts/codex_arbiter.sh`)
   for one concrete, binding resolution, fed back to the SAME task. The
   arbiter itself may only rule on technical matters; if the real blocker is
   product scope, accounting/tax, legal/compliance, or a locked-baseline
   change, it returns `ARBITER VERDICT: ESCALATE` and the loop stops for the
   owner instead.
3. `ATTEMPTS` (default 2) bounds retries within a single fire; exhausting it
   on an ordinary technical setback ends only that fire — the SAME task
   resumes on the next fire via the persisted state, never via owner ping.

Governance hardening in `scripts/lib_governance.sh`:
- **Keyed state**: `last_rejection.txt`/`last_resolution.txt` are written
  atomically with a `KEMFAI_STATE_TASK_ID` header and only ever read back
  after validating that header against the currently pinned task in
  `current_task.txt`. Stale (different-task), partial, or hand-edited state
  fails the check and reads as empty — it can never leak into another task.
- **Pin-first ordering**: pin discipline is checked before any escalation or
  question marker is even inspected. A mismatched Task ID is always a pin
  violation, never an escalation, no matter what the executor claims.
- **Escalation category validation**: a `KEMFAI_OWNER_ESCALATION` marker (or
  a legacy Decision Request) is never trusted on its own — its content must
  classify against one of the four real categories above, or it is
  downgraded to an ordinary technical setback.
- **No arbitrary truncation**: reviewer blockers and arbiter resolutions
  flow through in full; only a large global safety ceiling
  (`KEMFAI_STATE_MAX_BYTES`, default 1 MiB) guards against pathological
  output, never a 4K/6K content cut.

Preserved invariants: single-flight lock (`/tmp/kemfai_loop.lock`), clean
working-tree rollback on any non-accepted outcome, Claude-primary/GLM-fallback
executor order with independent Codex review, and no model approves its own
implementation. Deterministic mocked tests (no real model calls) live in
`scripts/tests/`.

## Operating principle
NO SINGLE MODEL BECOMES A BOTTLENECK OR SINGLE POINT OF FAILURE.
