# KEMFAI Constitution (v0.1 - draft)

Permanent engineering and product principles for KEMFAI.
Any change requires explicit owner approval.

## Product principles (Spec section 1.1)
- P-01 Simple by default - advanced accounting fields use progressive disclosure.
- P-02 Connected everywhere - no dead-end records; every object exposes related records and sources.
- P-03 No dead numbers - every material KPI/report/dashboard number drills to calculation, transactions, sources.
- P-04 Account = What; Dimension = Where/Who/Why - do NOT multiply GL accounts for branch/dept/project/cost center/salesperson.
- P-05 AI is assistive - AI detects/suggests/explains; posting/approval controlled by authorized users only.
- P-06 Auditability - no silent deletion of posted accounting. Reverse/correct/repost with full history.
- P-07 Configuration over hard-coding - plans, entitlements, tax rules, approvals, dimensions are data-driven.

## Engineering principles
1. Vertical slices end-to-end (UI -> API -> domain -> posting -> audit -> tests).
2. Odoo Community only - never modify Odoo core; extend via kemfai_ modules.
3. DB per tenant from launch. No shared accounting DB between customers.
4. API/BFF boundary - customer never sees native Odoo UI.
5. Deterministic posting - AI never autonomously creates final accounting entries.
6. Idempotent critical workflows - payments, posting, provisioning, callbacks, background jobs.
7. Money = value + currency + precision + base currency.
8. Dates/times = company timezone + audit timestamps.
9. Files/evidence = secure object storage refs, not DB blobs.
10. English + Arabic Day 1 - full LTR/RTL across UI, invoices, reports, documents.

## Prohibited
- Direct Odoo core edits.
- Copying proprietary Odoo Enterprise or QuickBooks code.
- Destructive edits on posted accounting.
- Hard-coded plan/tax/approval/localization rules.
- Native Odoo UI reaching customer-facing surfaces.
- AI-generated ledger balances or autonomous posting without authorized approval.
- Manufacturing / CRM / website / helpdesk scope in the initial accounting product.

## Governance
- Owner: Islam El Berkawy (eslam.berkawy@gmail.com).
- Baseline docs: docs/KEMFAI_Blueprint_v1.0, docs/KEMFAI_Implementation_Spec_v1.1_FINAL.
- Change to baseline: requires owner approval + version bump + changelog entry.
