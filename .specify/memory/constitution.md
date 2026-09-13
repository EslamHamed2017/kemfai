<!--
Sync Impact Report
Version change: (template, unratified) → 1.0.0
Rationale: Initial ratification (MAJOR). First concrete constitution for KEMFAI, derived
from docs/KEMFAI_Blueprint_v1.0.txt, docs/KEMFAI_Spec_v1.1_FINAL.txt, the draft root
CONSTITUTION.md, and AGENTS.md.
Modified principles: n/a (template placeholders → concrete principles, not a renaming)
Added principles:
  I. Product Non-Negotiables (P-01–P-07)
  II. Odoo Community Foundation, No Core Modification
  III. Customer-Facing Boundary — API/BFF Only
  IV. Database-Per-Tenant Isolation
  V. Bilingual by Day 1 (English & Arabic)
  VI. Vertical Slices & Implementation Contract
  VII. Deterministic Data & Financial Integrity
Added sections:
  Quality Gates (Mandatory, Non-Bypassable)
  SpecKit Pipeline & Review Discipline
  Governance
Removed sections: generic template placeholder tokens
Templates requiring follow-up: none checked/updated by this command (out of scope per
scope guard); verify on next run of /speckit-plan, /speckit-tasks, /speckit-analyze that
their constitution-check gates reference these principles by name.
Deferred TODOs: none. All placeholders resolved from source documents and user input.
-->

# KEMFAI Constitution

## Core Principles

### I. Product Non-Negotiables (P-01–P-07) (NON-NEGOTIABLE)

These seven rules originate in the locked Spec baseline (Spec §1.1) and MUST NOT be
weakened, reinterpreted, or silently dropped by any implementation decision:

- **P-01 Simple by default**: Advanced accounting fields MUST use progressive disclosure;
  default transaction screens MUST NOT be crowded with rarely-used fields.
- **P-02 Connected everywhere**: No dead-end records. Every business/financial object MUST
  expose its related records and source relationships (360° navigation).
- **P-03 No dead numbers**: Every material KPI, report, or dashboard number MUST drill down
  to its calculation, transactions, and source documents.
- **P-04 Account = What; Dimension = Where/Who/Why**: GL accounts MUST NOT be multiplied to
  represent branch, department, project, cost center, or salesperson. Use dimensions instead.
- **P-05 AI is assistive**: AI MAY detect, suggest, and explain. Final posting and approval
  of accounting entries remains controlled exclusively by authorized human users. AI MUST
  NOT autonomously create or post final accounting entries.
- **P-06 Auditability**: No silent deletion of posted accounting. Corrections MUST use
  reverse/correct/repost flows that preserve full history.
- **P-07 Configuration over hard-coding**: Plans, entitlements, tax rules, approval rules,
  and dimensions MUST be data-driven, never hard-coded (e.g. no `if plan == "Starter"`).

**Rationale**: These are the product's identity — they distinguish KEMFAI from a generic
Odoo deployment and from a spreadsheet-simple tool that lacks control. They are quoted
verbatim from the locked Spec and are the first thing any design or code review checks.

### II. Odoo Community Foundation, No Core Modification

KEMFAI uses Odoo Community as its business/accounting engine. All KEMFAI-specific behavior
MUST live in isolated `kemfai_*` modules. Direct edits to Odoo core code are PROHIBITED —
extension only, via standard Odoo extension mechanisms (inheritance, hooks, views). Copying
proprietary Odoo Enterprise or QuickBooks code is PROHIBITED; desired capabilities MUST be
reproduced through original implementation using Odoo Community/LGPL-compatible code only.
Manufacturing, CRM, website, and helpdesk scope are out of the initial accounting product.

**Rationale**: Core edits and proprietary copying create unmaintainable forks, licensing
risk, and upgrade dead-ends. The Blueprint's Build Matrix (reuse/extend/custom) depends on
a clean boundary between what Odoo provides and what KEMFAI adds (Blueprint §6, §10).

### III. Customer-Facing Boundary — API/BFF Only

The customer MUST NEVER be exposed to the native Odoo UI. All customer- and staff-facing
interaction happens through the KEMFAI Next.js frontend, mediated by the KEMFAI-controlled
API/BFF layer. This boundary is what allows KEMFAI to deliver QuickBooks-style simplicity
on top of Odoo's relational depth (Spec §1, §21).

**Rationale**: The product promise is "QuickBooks simplicity + Odoo power." Any leak of raw
Odoo screens breaks that promise and exposes internal complexity the product exists to hide.

### IV. Database-Per-Tenant Isolation

Every customer/tenant MUST receive its own separate PostgreSQL/Odoo database from launch.
No shared accounting database between customers, ever. Tenant routing and provisioning are
controlled by KEMFAI (Spec §21, §29 — LOCKED). Domain records MUST carry immutable IDs and
explicit tenant/company ownership.

**Rationale**: Financial data isolation is a hard security and compliance requirement for a
multi-tenant accounting SaaS; logical-only isolation is an explicitly rejected weaker option
per the locked Gate 0 decision.

### V. Bilingual by Day 1 (English & Arabic)

English and Arabic MUST be supported from Day 1, including full LTR/RTL behavior across UI,
invoices, reports, and documents (Spec §29 — LOCKED). Localization is not a post-launch
retrofit; every UI component and customer-facing document MUST be designed bilingual-first.

**Rationale**: Primary launch markets are UAE, KSA, and Egypt. Arabic support is a market
entry requirement, not an enhancement, and RTL support is far cheaper to build in than to
retrofit.

### VI. Vertical Slices & Implementation Contract

Features MUST be implemented as vertical slices end-to-end: UI → API/BFF → domain/service →
Odoo/posting → audit → tests (Spec §25, Blueprint). For every story:
- Permissions, tenant/company scope, and audit events MUST be defined.
- Empty, error, and loading states, and accessibility, MUST be defined.
- Every financial feature MUST define posting behavior, reversals, multi-currency handling,
  and dimension propagation.
- Every KPI/report MUST document its calculation logic and drill-down target.
- Incomplete modules MUST sit behind feature flags. Partially implemented financial
  workflows MUST NOT reach production users.
- If the specification is ambiguous on a material accounting/product decision, the agent
  MUST stop and raise a Decision Request rather than inventing behavior.

**Rationale**: Slicing end-to-end (rather than by architectural layer) keeps every merged
increment shippable and testable, and prevents half-built financial workflows from reaching
customers.

### VII. Deterministic Data & Financial Integrity

Posted accounting entries are append/correct/reverse-oriented; destructive edits on posted
accounting are PROHIBITED. Money values MUST carry currency, precision, and base-currency
handling. Dates/times MUST carry company/user timezone semantics and audit timestamps.
Files/evidence MUST use secure object storage references, not database blobs, where
avoidable. Critical workflows — payments, posting, provisioning, connector ingestion,
callbacks, and background jobs — MUST be idempotent. All financial source relationships
MUST be explicit, queryable, and auditable.

**Rationale**: These are the concrete engineering mechanics that make P-05/P-06 (assistive
AI, auditability) and the 360° connectivity principle (P-02) actually hold up under
concurrent access, retries, and multi-currency, multi-tenant operation (Spec §22).

## Quality Gates (Mandatory, Non-Bypassable)

Every change MUST pass, in order: **Spec Gate → Accounting/Data Gate → Test Gate →
Security/Tenant Gate → Acceptance Gate**. These gates exist specifically to protect
financial correctness and tenant isolation and MUST NOT be skipped or reordered for speed.

Automated tests MUST cover, at minimum: debits = credits on every posting path, tenant
isolation (no cross-tenant data leakage), authorization/permission enforcement, idempotency
of critical workflows, and source linkage (every number traces to its transaction).

Main branch MUST remain runnable at all times. Merges require an open PR, passing automated
tests, and green CI — no direct commits to `main`.

## SpecKit Pipeline & Review Discipline

Work MUST flow through the SpecKit pipeline in order: Product Baseline → Constitution →
Specify → Clarify → Plan → Tasks → Analyze → Implement → Continuous Review → Final
Acceptance. Core rule: **no spec → no task ID → no implementation → no test → no merge.**

**No self-review**: no agent or model may approve or accept its own implementation as the
final reviewer. Review and acceptance MUST be performed by an independent reviewer role.
Cross-consistency checks (Constitution ↔ Spec ↔ Plan ↔ Tasks ↔ docs) MUST be performed
independently of the authoring agent.

Every task MUST have a defined Primary owner and an independent Reviewer, so no single
agent or model is a bottleneck or single point of failure for the whole pipeline.

## Governance

This constitution supersedes all other project practices, including AGENTS.md and any
per-module conventions, where a conflict exists. AGENTS.md and other operating documents
MUST remain consistent with it.

**Baseline documents**: `docs/KEMFAI_Blueprint_v1.0` and `docs/KEMFAI_Spec_v1.1_FINAL` are
the locked product/functional baseline. Any change to a locked baseline decision (including
the items frozen in Spec §29 and `docs/GATE0_DECISIONS.md`) requires explicit approval from
the Owner, Islam El Berkawy (eslam.berkawy@gmail.com), before it may be implemented.

**Amendment procedure**: Amendments to this constitution MUST be proposed explicitly (not
folded silently into an unrelated change), MUST update the version per the policy below, and
MUST record the change in the Sync Impact Report at the top of this file. Material changes
(anything touching a Core Principle or a locked baseline decision) require Owner approval.

**Versioning policy**: Semantic versioning applies to this document:
- **MAJOR** — backward-incompatible governance changes, or removal/redefinition of a
  Core Principle.
- **MINOR** — a new principle or section added, or materially expanded guidance.
- **PATCH** — clarifications, wording, typo fixes, non-semantic refinements.

**Compliance review**: All specs, plans, and PRs MUST verify compliance with the Core
Principles above before merge. Any complexity or deviation from these principles MUST be
explicitly justified in the relevant spec or PR description; unjustified deviations MUST be
rejected at the Spec Gate or Acceptance Gate.

**Version**: 1.0.0 | **Ratified**: 2026-09-13 | **Last Amended**: 2026-09-13
