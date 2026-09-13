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

## Operating principle
NO SINGLE MODEL BECOMES A BOTTLENECK OR SINGLE POINT OF FAILURE.
