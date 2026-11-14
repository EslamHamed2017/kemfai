# Accounting Policy Matrix — Phase 2 Approved Baseline v1.0

**Status:** APPROVED — v1.0
**Feature:** `003-accounting-foundation`
**Created:** 2026-10-29
**Approved:** 2026-11-07T10:40:40+04:00
**Approver:** Eslam El Berkawy — Finance Owner
**Effective for design/development/testing:** 2026-11-07
**Production activation:** Only after required implementation, automated tests, independent review, and acceptance gates pass
**Scope:** Global KEMFAI baseline for all companies; approved Country Packs may add jurisdiction-specific requirements without rewriting posted history
**Authority:** `docs/KEMFAI_Spec_v1.1_FINAL.txt` lines 336–338 and 399; `docs/GATE0_DECISIONS.md` decision 6.

## Purpose

The locked baseline requires owner-approved policy values before the posting engine is frozen. The four-state period lifecycle and the non-negotiable controls below are already locked; they are not pending choices. Only the seven policy categories in the decision table require owner approval.

## Already locked — not awaiting approval

1. Parent/reporting accounts cannot receive postings.
2. Posted history cannot be silently edited or deleted; corrections preserve the original through linked reversal/correction.
3. AI cannot autonomously approve or post final accounting entries.
4. Account represents **what**; dimensions represent **where/who/why**.
5. Period lifecycle is exactly `Open → Soft Close → Finance Review → Hard Close`, with authorized, reasoned, audited reopening.
6. Every posting path is tenant/company scoped, permission controlled, idempotent and auditable.
7. Customer-facing workflows remain behind KEMFAI UI and API/BFF; native Odoo UI is not exposed.
8. English/Arabic and LTR/RTL are Day-1 requirements for customer-facing surfaces.

## Approved policy values — v1.0

| Locked category | Approved Phase 2 value | Status |
|---|---|---|
| Posting | Posting is an explicit action by a human with `Post` permission. Maker–Checker is configurable per company and may be activated by amount or other configured criteria. When active, the maker cannot approve their own entry. Balance, scope, audit, period and lock controls are never bypassed; AI may suggest or review but cannot post. | APPROVED |
| FX | Each company configures an approved rate source, including an external provider or controlled manual entry. The effective rate follows the accounting transaction date. Manual override requires specific permission and a recorded reason. Transaction amount, base amount, rate, source and effective date are retained immutably with the entry. Automated realization and revaluation are deferred to a separately specified FX workflow. | APPROVED |
| Rounding | Official currency precision is authoritative and no amount is silently truncated. A company/currency-configured minor-unit tolerance may create a transparent line to a configured rounding account; any excess blocks posting. Original and rounded values, actor and rule version remain auditable. | APPROVED |
| Inventory valuation/costing defaults | Inventory valuation and cost postings remain inactive in this slice. The later Inventory slice will let each company/localization select an approved method such as AVCO, FIFO or Standard Cost; Phase 2 must not invent inventory postings or impose a global costing default. | APPROVED |
| Reversals and controlled correction | The original posted entry remains immutable. A user with the separate `Correct Posted Entry` permission may use a correction experience that creates a linked full reversal and a new corrected entry; it never mutates history in place. A reversal-only action remains available. Reason is mandatory, the reversal date must be in an allowed period, the default journal is the original journal unless configured otherwise, Maker–Checker applies when configured, and duplicate reversal/correction chains are prevented. | APPROVED |
| Period controls | `Open`: authorized posting/reversal/correction is allowed. `Soft Close`: routine posting is blocked; specifically authorized adjustments may proceed with a reason. `Finance Review`: only approved adjustment workflows using Maker–Checker may proceed. `Hard Close`: posting, reversal and correction are blocked. Reopening requires separate permission, a mandatory reason and append-only audit history. Accounting-date period evaluation cannot be bypassed by changing system time. | APPROVED |
| Revenue/recognition rules | Accrual basis is the default company accounting basis: revenue is recognized when earned under the applicable transaction workflow, not merely when cash is collected. Cash-basis views may be provided for tax or management reporting without rewriting source entries. Deferred revenue, subscriptions, contracts and allocation across periods require later separately specified workflows. Country Packs may add approved jurisdiction-specific requirements. | APPROVED |

## Controls outside the seven policy categories

Dimension validation and opening-balance workflow are functional controls specified by the feature, not additional Accounting Policy Matrix categories. They remain data-driven and auditable but are not represented as owner-reserved rows in this matrix.

## Owner decision record

- **Decision:** All seven policy categories approved as Accounting Policy Matrix v1.0.
- **Approver:** Eslam El Berkawy — Finance Owner.
- **Approval timestamp:** 2026-11-07T10:40:40+04:00 (Dubai), equivalent to 2026-11-07T06:40:40Z.
- **Scope:** Global KEMFAI baseline for all companies. Approved Country Packs may add jurisdiction-specific requirements; they must be versioned and may not rewrite posted history.
- **Effective date:** 2026-11-07 for design, implementation and testing.
- **Production effect:** None by approval alone. Policy-dependent production capabilities remain disabled until their implementation, automated tests, independent review and acceptance gates pass.
- **Migration impact:** None. No production posted history exists under this matrix at approval time; future amendments must preserve the exact matrix version retained by posted entries.

Any amendment MUST record the decision date, approver, changed rows, company/localization scope, effective version/date, and migration impact. Approval of v1.0 removes the external policy gate only; it does not itself accept T151–T158 or authorize bypassing their specification, test, review, release-control, or production-activation gates.
