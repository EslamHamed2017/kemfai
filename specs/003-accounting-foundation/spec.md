# Feature Specification: KEMFAI Slice 2 — Accounting Foundation

**Feature Branch**: `feature/003-accounting-foundation`
**Created**: 2026-10-29
**Status**: Approved policy baseline v1.0 — implementation and production activation remain gated by specification, tests, independent review and acceptance
**Input**: User description: "Build Slice 2 accounting foundation: chart-of-accounts parent/posting accounts, tracking dimensions, journals, currencies, auditable double-entry posting, opening balances, reversals, and period locks, delivered as bilingual tenant-isolated vertical slices."

**Baseline references**: `docs/KEMFAI_Spec_v1.1_FINAL.txt` §§1.1, 2, 7, 22, 24–29; `docs/KEMFAI_Blueprint_v1.0.txt` §§1, 3, 8–10; `.specify/memory/constitution.md` v1.0.0; `docs/GATE0_DECISIONS.md`.

## Scope and Policy Gate

This slice establishes one deterministic posted ledger per company: compact chart of accounts (COA), normalized tracking dimensions, journals and currencies, draft journal entries, authorized posting, opening balances, reversals, period states, source linkage, and immutable audit history. Customer and staff users interact only through KEMFAI surfaces; native accounting-engine screens are never exposed.

Safe work on COA, dimensions, journals, currencies, draft entry capture, invariant validation, audit envelopes, and bilingual user experience may proceed independently. The Finance Owner has approved Accounting Policy Matrix v1.0; policy-dependent production behavior MUST nevertheless remain disabled until the applicable post-approval specification, implementation, automated-test, independent-review, acceptance and release-control gates pass.

### Accounting Policy Matrix — OWNER APPROVED v1.0

The locked baseline requires an explicit, data-driven matrix whose applicable defaults are selected by company/localization settings. Finance Owner Eslam El Berkawy approved Accounting Policy Matrix v1.0 on 2026-11-07. The authoritative values and decision metadata are recorded in `accounting-policy-matrix.md` for these categories:

- Posting
- Foreign exchange (FX)
- Rounding
- Inventory valuation/costing defaults
- Reversals
- Period controls
- Revenue/recognition rules

**DECIDED:** Accounting Policy Matrix v1.0 is approved. Approval removes the external policy-decision gate but does not activate production posting. Each policy-dependent workflow still requires its separately reviewed contract/model/live-proof addendum, implementation, tests, independent acceptance and release control.

Approval evidence MUST identify the matrix version, approving owner, approval timestamp, effective scope, and effective date. Any later matrix change is versioned and audited; it never rewrites previously posted history.

### Acceptance Execution Contract

Every story's final acceptance MUST exercise the real production boundary end to end: KEMFAI browser surface → authenticated API/BFF → production domain service → real Odoo Community addon/ORM → the exact dedicated tenant database → required audit persistence. Lower-level unit, contract, mocked-repository, intercepted-route, or direct-model tests are useful supplementary evidence but MUST NOT substitute for this path.

Every live acceptance fixture MUST be exact-owned and isolated: dynamic loopback-only ports, explicit ownership labels, readiness checks against the actual database/realm/resource used, bounded timeouts, unique tenant/company data, secret redaction, cleanup receipts, and zero surviving processes, containers, networks, volumes, databases, realms, buckets, or other test resources. It MUST NOT reuse or mutate unowned development/preview state.

For each story, acceptance MUST cover normal, loading, error, and empty behavior where applicable; authorization and cross-tenant/company denial; retry/idempotency; concurrent or stale-state behavior for mutations; audit failure; and EN/LTR plus AR/RTL. A pass requires deterministic assertions over persisted financial and audit state, not only an HTTP response or screenshot.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Maintain a compact chart of accounts (Priority: P1)

A Finance Manager structures company accounts as reporting parents and posting accounts, preserving a compact hierarchy rather than multiplying accounts for operational attributes.

**Why this priority**: Every ledger line needs a valid posting account, while parent accounts provide stable aggregation. This is the minimum accounting master data required by every later financial flow.

**Independent Test**: In one company, create a two-level parent hierarchy and a child posting account, verify the hierarchy and localized list, and prove that a line can select the posting account but not either parent.

**Financial contract**:
- **Permissions**: View requires `View`; create/edit/deactivate requires `Create`/`Edit` for COA in the selected company. `Post`, `Reverse`, or `Approve` grants alone do not permit COA maintenance.
- **Tenant/company scope**: Accounts are immutable-ID records owned by the current tenant and company. A user sees and mutates only authorized companies; cross-tenant identifiers are rejected without disclosure.
- **Audit**: Create, edit, re-parent, type change, and activate/deactivate attempts and outcomes record actor, tenant, company, before/after values, time, and correlation identifier.
- **Posting/reversal**: Parent accounts are always non-postable. Used accounts and posted history are never deleted; correction is by prospective master-data change and, for financial amounts, reversal/correction entry.
- **Multi-currency**: Account maintenance does not set exchange policy; ledger lines using an account retain transaction and company-base amounts/currencies.
- **Dimensions**: Branch, department, cost center, project, salesperson, entity, and custom tags are not encoded in account names/codes. Account-specific dimension requirements may be configured as rules.
- **UI/UX**: The hierarchy/list, labels, help, validation, loading, error, and empty states are available in EN/LTR and AR/RTL; accessibility includes keyboard operation, visible focus, semantic hierarchy, and screen-reader account type/status.

**Acceptance Scenarios**:
1. **Given** an authorized Finance Manager in Company A, **When** they create two parents and a posting child, **Then** the hierarchy is saved in Company A and each node is clearly identified as Parent or Posting.
2. **Given** a parent account, **When** any entry line attempts to use it, **Then** validation blocks the line before posting and names the non-postable account in the active language.
3. **Given** a posting account already referenced by a posted line, **When** an authorized user deactivates it, **Then** it is unavailable for new lines while historical entries and reports retain it unchanged.
4. **Given** a Company A user supplies a Company B or another tenant's account identifier, **When** the request is evaluated, **Then** access is denied, no foreign account data is returned, and the denied attempt is audited.
5. **Given** no accounts exist, a request is pending, or retrieval fails, **When** the COA screen renders, **Then** it shows respectively a localized empty-state action, non-blocking loading state, or recoverable error with retry.
6. **Given** two authorized users edit the same account version concurrently, **When** the later request is evaluated, **Then** stale input cannot silently overwrite the accepted change and the user receives a recoverable localized conflict.

---

### User Story 2 — Configure and apply tracking dimensions (Priority: P1)

An Accounting Manager defines active values for Entity, Branch/Location, Department, Cost Center, Project, Salesperson, and configurable custom dimensions/tags, then defines data-driven requirements by account or transaction type.

**Why this priority**: Dimensions preserve Account = What and Dimension = Where/Who/Why, preventing COA explosion while making entries analytically useful.

**Independent Test**: Configure a required Project and Cost Center rule for one account/transaction context, then show that a line missing either value is rejected and a complete line retains both values without creating new accounts.

**Financial contract**:
- **Permissions**: `View` sees authorized dimension masters; `Create`/`Edit` maintains values and validation rules. Entry users may select only values allowed by their Company/Branch/Department/Project scope.
- **Tenant/company scope**: Definitions and values belong to one tenant and have explicit company applicability; no value can be attached to a line in an unrelated company or tenant.
- **Audit**: Definition/value/rule create, edit, activation, deactivation, and rejected cross-scope use are audited with before/after state.
- **Posting/reversal**: Required-dimension validation is fully usable on drafts before policy approval. Posted-line immutability and reversal propagation remain binding contracts for Stories 4–5 and are not part of this story's policy-independent final acceptance.
- **Multi-currency**: Dimension validation is currency-neutral and dimensions attach identically to transaction-currency and base-currency amounts.
- **Dimensions**: Built-in categories and custom tags remain normalized, selectable attributes; Project remains a first-class dimension value and is not represented by a duplicate GL account.
- **UI/UX**: Advanced dimensions use progressive disclosure. EN/LTR and AR/RTL screens include accessible labels, keyboard selection, announced validation, and localized loading/error/empty states.

**Acceptance Scenarios**:
1. **Given** an authorized manager, **When** they activate values and a required-dimension rule for a company, **Then** the rule applies only in that company and its effective configuration is audited.
2. **Given** a draft line subject to a Project and Cost Center requirement, **When** either is missing, **Then** posting is blocked with line-specific localized errors and no ledger movement occurs.
3. **Given** a draft line with valid dimensions, **When** it is saved and retrieved through the real production path, **Then** the same scoped dimension identifiers and labels are retained without creating additional GL accounts or any ledger movement.
4. **Given** a dimension value referenced by an existing draft, **When** it is deactivated, **Then** it cannot be selected for new lines, remains visible on the existing draft for correction, and the draft must be revalidated before any later policy-dependent post.
5. **Given** an empty, slow, or failed dimension-value query, **When** a selector opens, **Then** it exposes an accessible localized empty, loading, or retryable error state without silently dropping required values.
6. **Given** concurrent edits to one dimension rule or value, **When** a stale mutation arrives, **Then** it cannot silently replace the accepted version and no partially changed validation rule becomes effective.

---

### User Story 3 — Configure journals and company currencies (Priority: P1)

A Finance Manager configures company journals and enables currencies needed for entries, while the company base currency remains the reporting anchor.

**Why this priority**: Every entry belongs to a journal and every money value must carry currency, precision, and base-currency handling before reliable posting is possible.

**Independent Test**: Create a journal, enable a foreign currency, draft a balanced transaction-currency entry, and verify that both transaction and base-currency values are preserved without selecting an FX policy.

**Financial contract**:
- **Permissions**: `View` reads journals/currencies; `Create`/`Edit` maintains them. Only separately authorized users may `Post` or `Reverse` entries.
- **Tenant/company scope**: Journals are company-owned; enabled currencies and base currency are applied only within the selected tenant/company. Foreign journal or currency identifiers are rejected.
- **Audit**: Journal and currency activation/deactivation, configuration changes, denied access, and base-currency-sensitive changes are audited.
- **Posting/reversal**: Only active journals accept new drafts/posts. Posted entries remain associated with their historical journal; reversals use an allowed journal and retain explicit linkage.
- **Multi-currency**: Every foreign-currency line stores currency, foreign amount, company-base amount, precision, and rate reference/effective date. FX and rounding outcomes remain policy-matrix controlled.
- **Dimensions**: Journals do not replace dimensions; selected lines still carry and validate applicable dimensions.
- **UI/UX**: Journal/currency lists and forms support EN/LTR, AR/RTL, keyboard and screen-reader use, clear money/currency notation, and localized loading/error/empty states.

**Acceptance Scenarios**:
1. **Given** an authorized Finance Manager, **When** they create an active journal for Company A, **Then** it is selectable only for Company A drafts and the creation is audited.
2. **Given** an enabled foreign currency and supplied rate reference, **When** a draft line is saved, **Then** transaction currency/amount and base-currency amount are both visible and retained at their declared precision.
3. **Given** an inactive journal or currency, **When** a new draft or post attempts to use it, **Then** the action is blocked without changing the ledger.
4. **Given** the Finance Owner matrix is not approved, **When** a policy-dependent foreign-currency post is requested in production, **Then** posting is unavailable while draft capture and preview remain usable.
5. **Given** no journals/currencies, delayed retrieval, or failure, **When** the screen renders, **Then** an accessible localized empty, loading, or retryable error state appears.
6. **Given** concurrent configuration changes, **When** a stale journal/currency mutation is submitted, **Then** it cannot silently overwrite the accepted version and drafts retain a deterministic configuration reference.

---

### User Story 4 — Draft, validate, and post a manual journal entry (Priority: P1)

An Accountant prepares a manual journal entry, reviews its financial impact and source context, and an authorized human posts it exactly once after all controls pass.

**Why this priority**: Deterministic, permission-controlled double-entry posting is the foundation's central outcome and the source of truth for later reporting and subledgers.

**Independent Test**: With an approved matrix version in a controlled acceptance environment, submit one balanced entry to active posting accounts, retry the same posting request, and verify one immutable posted entry, equal debits/credits, dimensions, currencies, source linkage, and audit history.

**Financial contract**:
- **Permissions**: `Create`/`Edit` manages own authorized drafts; `View` reads permitted entries; `Post` is required to post. Posting is always an explicit authorized-human action; AI or background suggestions cannot post.
- **Tenant/company scope**: Header, journal, lines, accounts, dimensions, source, currency, and actor must resolve to the same selected tenant/company and authorized scope. Mixed-company or cross-tenant entries are rejected atomically.
- **Audit**: Draft creation/edit, validation results, approval where configured, post request/outcome, idempotent replay, denial, and source linkage are immutable audit events with actor, company, matrix version, correlation/idempotency identifier, and timestamps.
- **Posting/reversal**: Posting requires at least two lines, equal total debits and credits in company base currency, active posting accounts/journal, valid period, required dimensions, complete currency data, and approved applicable matrix. Success is atomic and immutable. Corrections use Story 5; destructive edit/delete is prohibited.
- **Multi-currency**: Lines preserve transaction and company-base amounts, currency, precision, and rate reference. Balance is enforced in company base currency; FX/rounding treatment follows the approved matrix and is not selected here.
- **Dimensions**: Header defaults may propagate to lines, but line-level applicable rules are validated and posted values remain queryable.
- **UI/UX**: A progressively disclosed composer and impact preview support EN/LTR and AR/RTL; accessible grid navigation, error summary and line focus, announced status, and explicit loading/error/empty-draft states are required.

**Acceptance Scenarios**:
1. **Given** a user with Create but not Post, **When** they save a valid entry, **Then** it remains Draft and no ledger balance changes.
2. **Given** an authorized poster, approved applicable matrix, open allowed period, and a fully valid balanced draft, **When** the user confirms Post, **Then** one immutable posted entry is created atomically and the impact/source links are visible.
3. **Given** unequal base-currency debits and credits, a parent account, missing required dimension, inactive journal, or disallowed period, **When** posting is requested, **Then** the whole request fails with localized field/line reasons and creates no partial ledger lines.
4. **Given** the same post request is retried with the same idempotency identifier, **When** it is processed again, **Then** the original result is returned and no duplicate entry or audit outcome is created.
5. **Given** a suggestion generated by AI or automation, **When** no authorized human confirms it, **Then** it cannot become posted.
6. **Given** a cross-tenant or mixed-company component, **When** posting is requested, **Then** the request is denied atomically, foreign data is not disclosed, and the denial is audited.
7. **Given** a blank draft, pending validation/post, or service failure, **When** the composer renders, **Then** it shows accessible localized empty guidance, progress that prevents duplicate submission, or a recoverable error preserving draft input.

---

### User Story 5 — Reverse and correct a posted entry (Priority: P1)

An authorized Finance Manager reverses an erroneous posted entry and, when needed, creates a linked correcting draft without changing the original history.

**Why this priority**: Immutable history is incomplete without a controlled correction path; users must fix errors without silent deletion.

**Independent Test**: Reverse one posted multi-currency, dimensioned entry and verify equal-and-opposite amounts, copied currency/dimensions, bidirectional links, unchanged original, audit trail, and idempotent retry.

**Financial contract**:
- **Permissions**: `Reverse` is required; creating/editing a correction also requires the corresponding permission, and posting it separately requires `Post`.
- **Tenant/company scope**: The actor, original entry, reversal journal/date, and correction remain in the original tenant/company and permitted scope.
- **Audit**: Request reason, actor, original/reversal/correction links, dates, matrix version, approval where configured, success/denial, and retries are recorded immutably.
- **Posting/reversal**: The original remains unchanged. A reversal is a new balanced, equal-and-opposite posted entry governed by the approved reversal and period-control matrix categories. Repeating one request cannot create another reversal.
- **Multi-currency**: Reversal retains original transaction currency/amount, base amount, precision, and rate reference unless an approved policy explicitly determines otherwise; this spec selects no such policy.
- **Dimensions**: Reversal lines copy original dimensions. A linked correction may change dimensions subject to current validation, with differences auditable.
- **UI/UX**: The original/reversal/correction timeline and reason form support EN/LTR, AR/RTL, keyboard/screen-reader use, confirmation, and localized loading/error/empty-related-record states.

**Acceptance Scenarios**:
1. **Given** an authorized reverser and eligible posted entry, **When** they provide a reason and confirm reversal, **Then** a linked equal-and-opposite entry is posted and the original remains immutable.
2. **Given** a user without Reverse permission or outside company scope, **When** they request reversal, **Then** no financial change occurs and the denial is audited without foreign detail disclosure.
3. **Given** a reversal request is retried, **When** the same idempotency identifier is processed, **Then** the existing reversal result is returned with no duplicate.
4. **Given** a reversal date falls in a disallowed period or requires an unapproved policy, **When** reversal is requested, **Then** it is blocked with a localized reason and no partial entry.
5. **Given** related-entry retrieval is empty, loading, or fails, **When** the timeline renders, **Then** it exposes the corresponding accessible localized state.

---

### User Story 6 — Post controlled opening balances (Priority: P2)

An Accounting Manager prepares opening-balance lines for a defined cutoff, validates them, reviews a control summary, and an authorized human posts them as an explicitly identified opening entry.

**Why this priority**: New companies and migrations need a controlled starting ledger, but ordinary journal posting can be proven before migration/opening workflows.

**Independent Test**: Prepare a balanced opening set with foreign currency and dimensions, validate the control totals, post once, and trace every opening line to the batch and audit evidence.

**Financial contract**:
- **Permissions**: `Create`/`Edit` prepares the batch; `Approve` applies where configured; `Post` posts it; `Reverse` corrects a posted opening batch.
- **Tenant/company scope**: A batch has one tenant, company, cutoff, and base currency; all accounts, dimensions, and currencies must be valid in that company.
- **Audit**: Import/manual creation, mapping, validation, preview, approval, posting, rejection, reversal, actor, source evidence reference, and control totals are recorded.
- **Posting/reversal**: Opening debits and credits must balance in base currency and pass the same posting invariants. Posting is atomic/idempotent and identifies the entry as opening. Changes after posting use linked reversal/correction, never overwrite.
- **Multi-currency**: Each applicable line retains foreign and base amounts, currency, precision, and rate reference; matrix-controlled FX/rounding choices remain unresolved until approval.
- **Dimensions**: Imported or entered dimensions are validated against active company values and applicable rules; they propagate to posted lines and reversals.
- **UI/UX**: Prepare → validate → preview/control totals → approve → post is available in EN/LTR and AR/RTL, with accessible table/error navigation and localized loading/error/empty-file-or-batch states.

**Acceptance Scenarios**:
1. **Given** a balanced valid opening batch, approved applicable matrix, and authorized poster, **When** posting is confirmed, **Then** exactly one opening entry is posted and every line traces to its batch and evidence.
2. **Given** totals do not balance or a line has invalid account/currency/dimension data, **When** validation runs, **Then** posting remains unavailable and row-level errors plus control-total differences are shown.
3. **Given** a posted opening batch, **When** a correction is needed, **Then** the system requires linked reversal/correction and preserves the original batch.
4. **Given** a cross-company line or unauthorized actor, **When** the batch is validated or posted, **Then** it is rejected atomically and the attempt is audited.
5. **Given** no batch/file, long validation, or failure, **When** the workspace renders, **Then** an accessible localized empty, progress, or retry state appears without losing accepted input.

---

### User Story 7 — Control accounting periods (Priority: P2)

A Finance Manager moves a company period through Open, Soft Close, Finance Review, and Hard Close, while authorized reopening is explicit and logged.

**Why this priority**: Period control prevents late or silent ledger changes, but its final enforcement choices are policy-dependent and therefore follow core posting capability.

**Independent Test**: Transition a period through all named states, verify unauthorized transitions fail, verify posting/reversal checks consume the current state and approved matrix, and reopen with a reason while retaining the full history.

**Financial contract**:
- **Permissions**: `View` reads state/history; `Edit` plus `Approve`, scoped to period control, is required to change state or reopen. `Post`/`Reverse` alone do not grant period-control authority.
- **Tenant/company scope**: Periods and transitions apply to exactly one tenant/company; dates use company timezone semantics.
- **Audit**: Every attempted/successful transition and reopening records prior/new state, actor, reason where required, company, time, and applicable matrix version.
- **Posting/reversal**: Posting and reversal consult period state plus the approved period-control/reversal matrix. This specification names no allowed-action table. No state transition rewrites ledger history.
- **Multi-currency**: Period controls apply equally to base- and foreign-currency entries; FX period treatment remains matrix-controlled.
- **Dimensions**: Period state is company-wide unless an approved policy later says otherwise; it never changes posted dimensions.
- **UI/UX**: Status, transition controls, history, and blocked-action explanations support EN/LTR, AR/RTL, keyboard/screen readers, non-color-only status, and localized loading/error/empty-history states.

**Acceptance Scenarios**:
1. **Given** an authorized controller, **When** they transition Open → Soft Close → Finance Review → Hard Close, **Then** each state is effective for the company and every transition is appended to history.
2. **Given** an unauthorized user or another-company user, **When** they attempt a transition/reopen, **Then** the state is unchanged and the denial is audited.
3. **Given** a posting or reversal request in any period state, **When** evaluated, **Then** the current approved matrix determines allow/block behavior and the result cites the applicable state without this specification assuming a policy.
4. **Given** an authorized reopening request with required reason, **When** it succeeds, **Then** prior history remains intact and the new state, actor, reason, and time are appended.
5. **Given** no history, delayed retrieval, or failure, **When** the period screen renders, **Then** it shows an accessible localized empty, loading, or retryable error state.

## Edge Cases

- A hierarchy cycle, self-parent, or move beneath a descendant is rejected before save; no partial hierarchy change occurs.
- An account code/name conflict is evaluated within company scope and produces a localized, non-destructive error.
- A parent with children cannot be converted to posting if doing so would invalidate the hierarchy; a posting account with posted history cannot be converted in a way that changes historical meaning.
- Deactivation never removes values from posted history; inactive accounts, journals, currencies, and dimensions are excluded from new selection.
- Zero-line, one-line, zero-total, all-debit, all-credit, negative-value, or both-debit-and-credit-on-one-line entries are rejected according to deterministic line and balance validations; correction uses explicit debit/credit lines, not ambiguous signs.
- Amounts beyond declared currency precision are not silently truncated; treatment awaits the approved rounding policy and posting remains blocked where that policy is required.
- A missing, stale, expired, or inapplicable exchange-rate reference blocks policy-dependent posting without discarding the draft.
- Two users posting the same draft concurrently yield one posted result; later requests receive the existing result.
- A master record deactivated between validation and post causes the atomic post to fail and requires revalidation.
- Company timezone determines the accounting date/period; audit time remains unambiguous. Boundary instants around midnight and period end are tested.
- Reversal of an already reversed entry and reversal chains are prevented or handled only per the approved matrix; no duplicate reversal can occur.
- A policy-matrix version changed after draft validation forces revalidation before posting; already posted entries retain the original version reference.
- Localization fallback never exposes raw translation keys; Arabic numeric and monetary presentation remains unambiguous and underlying values do not change when language/direction changes.
- Loss of connectivity during a mutating action leaves the user able to safely retry with the same idempotency identifier and determine the authoritative outcome.
- Audit-write failure for a financial state change fails the state change closed; financial mutation cannot succeed without its required audit evidence.

## Requirements *(mandatory)*

### Functional Requirements

#### Isolation, authorization, and presentation

- **FR-001**: Every accounting record MUST have an immutable identifier and explicit tenant and company ownership; all referenced accounting records in one financial operation MUST belong to the same tenant/company unless a future separately specified intercompany workflow applies.
- **FR-002**: The system MUST deny unauthorized or cross-tenant/company reads and writes without disclosing foreign record details and MUST audit denied financial actions.
- **FR-003**: The system MUST enforce the verbs View, Create, Edit, Post, Approve, Reverse, and Export independently, together with Company, Branch, Department, Project, and configured amount scopes where applicable.
- **FR-004**: Only an authorized human MUST be able to perform final posting, approval, reversal, or period-control actions; suggestions and automation MUST NOT bypass that action.
- **FR-005**: All customer-facing accounting experiences MUST be available in English/LTR and Arabic/RTL, including labels, validation, statuses, help, monetary display, and audit-action descriptions.
- **FR-006**: Every in-scope UI MUST provide perceivable and keyboard-operable controls, logical focus order, visible focus, programmatically associated names/errors/status, non-color-only meaning, and localized loading, error, and empty states.
- **FR-007**: Customer and staff accounting workflows MUST use KEMFAI-controlled surfaces and MUST NOT expose native underlying accounting-engine screens.

#### Chart of accounts and dimensions

- **FR-008**: The COA MUST distinguish non-postable parent/reporting accounts from posting accounts and MUST reject posting to a parent.
- **FR-009**: Account hierarchy operations MUST prevent cycles and preserve stable historical references.
- **FR-010**: Accounts referenced by posted history MUST NOT be destructively deleted; deactivation MUST preserve history and prevent new selection.
- **FR-011**: Operational attributes MUST be represented by normalized dimensions, not account-name/code proliferation.
- **FR-012**: The dimension catalog MUST support Entity, Branch/Location, Department, Cost Center, Project, Salesperson, and configurable custom dimensions/tags.
- **FR-013**: Authorized users MUST be able to define data-driven dimension validation rules by account and/or transaction type, with company applicability and effective status.
- **FR-014**: Posting validation MUST identify every missing, inactive, or out-of-scope required dimension at the affected line.
- **FR-015**: Posted dimension values MUST be immutable; reversal lines MUST copy them and correcting lines MUST retain an auditable relationship to original values.

#### Journals and currencies

- **FR-016**: Every draft and posted entry MUST reference one company-authorized journal; inactive journals MUST reject new drafts/posts without altering historical entries.
- **FR-017**: Every money value MUST declare currency and precision and, when currency differs from company base, MUST preserve transaction amount, base amount, rate reference, and effective date.
- **FR-018**: Currency and journal configuration MUST be company-scoped, auditable, and non-destructive once referenced by posted history.
- **FR-019**: Language or display-direction changes MUST NOT alter stored money, currency, rate, account, or dimension values.

#### Drafting and posting

- **FR-020**: Users with Create/Edit permission MUST be able to create and revise drafts without changing ledger balances.
- **FR-021**: A post MUST require at least two valid lines, active posting accounts and journal, valid currencies/rates, applicable dimensions, authorized company/period, and total base-currency debits exactly equal total base-currency credits.
- **FR-022**: Posting MUST be atomic: either the complete entry, source links, policy version reference, and required audit outcome become effective together, or none do.
- **FR-023**: Posting MUST be idempotent within tenant/company and operation scope; replaying the same identifier and payload MUST return the original result without duplicate ledger or audit outcomes, while reusing it for a different payload MUST be rejected.
- **FR-024**: Posted entries and lines MUST be immutable and MUST NOT be edited or deleted through ordinary workflows.
- **FR-025**: Each entry MUST expose bidirectional, queryable links to its source document/evidence where applicable, journal, original/reversal/correction, and audit timeline.
- **FR-026**: Validation MUST return actionable entry- and line-level reasons without creating partial ledger effects or losing the draft.
- **FR-027**: If required audit persistence fails, the associated financial state change MUST fail closed.
- **FR-028**: Policy-dependent production posting MUST remain disabled until an approved applicable Accounting Policy Matrix version exists.
- **FR-029**: Every posted entry MUST retain the exact approved matrix version applied; later matrix changes MUST NOT alter it or recalculate posted history.

#### Reversal, opening balances, and periods

- **FR-030**: Reversal MUST create a new balanced entry linked bidirectionally to the unchanged original and MUST require Reverse permission, reason, valid scope, approved policy, and period validation.
- **FR-031**: A reversal MUST preserve equal-and-opposite original transaction/base amounts, currency metadata, source relationship, and dimensions except where the approved matrix explicitly governs otherwise.
- **FR-032**: Reversal requests MUST be atomic and idempotent and MUST prevent duplicate reversals for one operation identifier.
- **FR-033**: Opening balances MUST follow Prepare → Validate → Preview/control totals → Approve where configured → Post and MUST be explicitly distinguishable from ordinary activity.
- **FR-034**: Opening batches MUST have one company, cutoff date, base currency, source/evidence reference, line-level validation results, and reconciled debit/credit control totals.
- **FR-035**: Posted opening balances MUST be immutable and correctable only by linked reversal/correction.
- **FR-036**: Company periods MUST support the named states Open, Soft Close, Finance Review, and Hard Close, plus authorized logged reopening, without this specification assigning posting rights to those states.
- **FR-037**: Every posting and reversal request MUST evaluate the current company period and applicable approved matrix version at execution time.
- **FR-038**: Period transitions MUST preserve append-only state history and record actor, company, previous/new state, company-effective time, audit time, reason when required, and applicable matrix version.

#### Audit and policy governance

- **FR-039**: Audit history MUST be append-only and record actor, action, tenant, company, target immutable identifier, before/after values where applicable, outcome, reason, timestamp, and correlation identifier.
- **FR-040**: Financial events MUST be traceable from source to entry and from entry back to source and audit evidence without dead-end records.
- **FR-041**: The Accounting Policy Matrix MUST be data-driven and versioned by company/localization applicability, effective date, approval status, approver, and approval time.
- **FR-042**: The matrix MUST contain only approved values for the locked categories: Posting; FX; Rounding; Inventory valuation/costing defaults; Reversals; Period controls; Revenue/recognition rules.
- **FR-043**: Drafts validated against a superseded or newly applicable matrix version MUST be revalidated before posting.
- **FR-044**: No posting, FX, rounding, costing, reversal, period-control, recognition, localization, permission, or approval policy MUST be embedded as an unchangeable product rule where configuration is required.
- **FR-045**: Incomplete policy-dependent financial workflows MUST remain inaccessible to production users behind a controlled release state; draft/master-data work MUST remain independently usable where safe.
- **FR-046**: Final acceptance for every story MUST traverse the KEMFAI surface, authenticated API/BFF, production domain service, real Odoo Community extension/ORM, the exact dedicated tenant database, and required audit persistence.
- **FR-047**: Mocked services, route interception, manufactured request context, schema-only checks, or direct-model calls MUST NOT be accepted as substitutes for FR-046, although they MAY provide supplementary lower-level coverage.
- **FR-048**: Live acceptance MUST use exact-owned isolated fixtures with dynamic loopback-only ports, actual-resource readiness, bounded timeouts, secret redaction, deterministic cleanup receipts, and zero survivors.
- **FR-049**: Every mutable master-data or financial workflow MUST reject or reconcile stale concurrent state deterministically and MUST prove retry behavior without duplicate or silent lost updates.
- **FR-050**: A success response alone MUST NOT prove a financial mutation; acceptance MUST verify the persisted tenant/company financial state, source links, policy/version references where applicable, and required audit outcome.

### Key Entities

- **Tenant**: Isolated customer workspace backed by its own accounting database; owns companies and routing context.
- **Company**: Legal/reporting scope with base currency, timezone, fiscal context, authorized users, periods, and applicable policy/localization settings.
- **Account**: Immutable-ID COA node with company, code/name, classification, Parent or Posting designation, optional parent, active status, and applicable dimension-rule relationships.
- **Dimension Definition**: Built-in or configurable analytic category with company applicability, status, labels, and allowed values.
- **Dimension Value**: Scoped Entity, Branch/Location, Department, Cost Center, Project, Salesperson, or custom value attachable to entry lines.
- **Dimension Rule**: Versioned, data-driven requirement/allowance tied to account and/or transaction type, company applicability, and effective status.
- **Journal**: Company-owned entry category with immutable identifier, localized name, active status, and historical entry relationships.
- **Currency Configuration**: Company base/enabled currency metadata, precision, status, and rate-reference requirements; it does not itself choose FX policy.
- **Journal Entry**: Company-owned Draft or Posted financial header with accounting date, journal, source, description, currency context, status, policy version, audit, and reversal/correction relationships.
- **Journal Line**: Debit/credit line to one posting account with transaction/base amounts, currency/rate metadata, dimensions, source context, and immutable posted identity.
- **Opening Balance Batch**: Controlled cutoff package with source evidence, validation/control totals, status, approver/poster, and resulting entry.
- **Accounting Period**: Company date interval with one of the four named states and append-only transition/reopening history.
- **Accounting Policy Matrix Version**: Owner-approved, effective, company/localization-applicable set of values for only the locked decision categories; v1.0 values and approval metadata are authoritative in `accounting-policy-matrix.md` and do not activate runtime behavior by themselves.
- **Audit Event**: Append-only evidence of attempt/outcome with actor, scope, target, before/after data, reason, correlation, and timestamps.
- **Source Link**: Bidirectional relationship connecting an entry/line to source document, evidence, opening batch, original, reversal, or correction.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In acceptance testing, 100% of attempts to post to parent accounts, with unbalanced base-currency totals, invalid company scope, missing required dimensions, inactive masters, or disallowed periods produce zero ledger lines.
- **SC-002**: For 100% of successfully posted entries across the acceptance corpus, total base-currency debits equal total base-currency credits exactly at declared precision.
- **SC-003**: Replaying each of at least 100 posting and reversal requests with the same identifier produces exactly one financial result per operation; altered-payload reuse is rejected.
- **SC-004**: Cross-tenant and unauthorized-company test suites achieve 100% denial with zero foreign financial fields or identifiers disclosed.
- **SC-005**: 100% of sampled posted entries can be traversed to journal, source/evidence where applicable, dimensions, applied policy version, audit event, and any reversal/correction; each linked record traverses back.
- **SC-006**: 100% of sampled reversals leave the original unchanged and produce one balanced, linked equal-and-opposite entry with retained currencies and dimensions, subject only to an explicitly approved matrix value.
- **SC-007**: A trained Accountant can create, validate, and submit a five-line manual entry in no more than 3 minutes in both English and Arabic during moderated acceptance testing, excluding approval wait time.
- **SC-008**: All seven story journeys pass in both EN/LTR and AR/RTL at 200% text zoom and by keyboard alone, with no clipped required content, direction errors, inaccessible control, or focus loss.
- **SC-009**: 100% of in-scope screens demonstrate distinct localized empty, loading, and recoverable error states, and retrying a financial action never duplicates it.
- **SC-010**: Account counts do not increase when the same expense is analyzed across branch, department, project, cost center, or salesperson in the acceptance scenario; analysis uses dimensions exclusively.
- **SC-011**: 100% of account/dimension/journal/currency changes, posts, reversals, opening-balance actions, period transitions, denials, and policy approvals sampled in UAT have complete audit fields defined by FR-039.
- **SC-012**: Before production posting is enabled, acceptance evidence confirms an Owner-approved applicable matrix version exists and no unresolved policy value is supplied by product code or this specification.
- **SC-013**: All seven story journeys pass through the real production boundary defined by FR-046; no story relies on a mock, intercepted route, manufactured identity/scope, or direct-model-only proof for final acceptance.
- **SC-014**: Every live acceptance run publishes an ownership/cleanup receipt and leaves zero owned or unowned-survivor processes, containers, networks, volumes, databases, realms, buckets, or mutated shared state.
- **SC-015**: For every mutable workflow, acceptance proves one concurrent/stale-state case, one safe retry case, and one audit-persistence failure case with no lost update, duplicate result, partial ledger state, or unaudited success.

## Assumptions

- Phase 1 already provides verified identity, tenant routing, initial company context, role/permission skeleton, append-only audit and idempotency patterns, bilingual/RTL foundations, and owned live acceptance fixtures; this slice extends rather than replaces them.
- A tenant may contain multiple companies, but this slice processes one selected company per accounting operation; intercompany accounting is separate scope.
- Each company has one base currency and timezone configured before posting; changing a base currency after posted activity is not assumed to be an ordinary edit.
- Drafts have no ledger effect and may be developed/tested before policy approval; production posting, reversal, opening posting, and policy-dependent period enforcement remain gated.
- Approval/maker-checker behavior is consumed when configured, but designing the general approval engine is outside this slice.
- Dimensions and their validation rules are configuration data. Reports/budgets will consume the same posted dimensions in later slices.
- Opening balances cover controlled initial ledger amounts and traceability; full migration mapping and all control-account reconciliation are later migration scope.
- Audit timestamps are unambiguous; accounting date and period evaluation use company timezone semantics.

## Dependencies

- Phase 1 authentication, tenant/company selection, role/scoping foundations, audit writer, idempotency contract, localization/RTL framework, and production-path acceptance environment.
- A provisioned dedicated database for each tenant and a configured initial company.
- Company base currency, timezone, and fiscal calendar inputs from setup.
- Finance Owner approval of the Accounting Policy Matrix before policy-dependent production posting is frozen/enabled.
- Localization settings and versioned country packs supply applicable defaults without placing regulatory rules in accounting core.
- Later transaction modules must provide explicit source relationships when they invoke this posting foundation.

## Out of Scope

- Selecting, recommending, or implementing final values for any Accounting Policy Matrix category before Owner approval.
- Sales/AR, purchases/AP, payments, bank import/reconciliation, inventory movement/valuation execution, fixed assets/depreciation, accrual/prepayment schedules, recurring journal scheduling, tax calculation/returns, payroll, expenses, projects' operational workflows, budgeting, and financial statement/report delivery.
- Realized/unrealized FX runs, revaluation, consolidation, intercompany elimination, and country-specific regulatory/e-invoice behavior.
- Full historical transaction migration, open AR/AP migration, inventory/assets/employee balance migration, and complete migration reconciliation reports; only the opening-ledger foundation is included.
- Designing the general approval/maker-checker engine, support-access lifecycle, subscription/entitlement system, identity system, backup/restore, or data-retention policy.
- Native accounting-engine UI, direct customer access to it, modifications to underlying core software, or copying proprietary product code.
- Autonomous AI creation, approval, or posting of final accounting entries.
- Manufacturing, CRM, website, helpdesk, mobile-first applications, and broad external integrations.
