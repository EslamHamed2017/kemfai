# Feature Specification: KEMFAI Slice 1 — SaaS Onboarding Shell

**Feature Branch**: `001-saas-onboarding-shell`

**Created**: 2026-09-13

**Status**: Draft

**Input**: User description: "Specify KEMFAI Slice 1: SaaS onboarding shell. Use docs/KEMFAI_Spec_v1.1_FINAL.txt sections 2, 3, 19, 26, 28 and 29 plus docs/KEMFAI_Blueprint_v1.0.txt and the ratified constitution. Scope this feature to: public plan selection; secure email signup and verification with MFA capability; creation of a tenant/workspace and initial company; strict database-per-tenant provisioning; English and Arabic from Day 1 with full LTR/RTL; company setup wizard for country, company identity, base currency, fiscal year, VAT/tax, industry and accounting setup; module/feature selection; manual bank-transfer billing lifecycle (instructions/reference, proof upload, pending review, Billing Admin approve/reject/request-more-information, audited activation); plan-feature-limit entitlement skeleton; onboarding checklist through customer, bank, product/service and first invoice readiness; customer support access grant/expiry/audit foundations; roles/scopes foundation. The customer must never see native Odoo UI. Include permissions, tenant/company scope, audit events, empty/error/loading states, accessibility, edge cases, assumptions, out-of-scope boundaries, measurable technology-agnostic success criteria, and testable acceptance scenarios."

**Baseline references**: `docs/KEMFAI_Spec_v1.1_FINAL.txt` §2 (Target Users, Roles & Permissions), §3 (SaaS Customer Journey), §19 (SaaS Subscription & KEMFAI Super Admin), §26 (Definition of Done — P0), §28 (Recommended Immediate Build Sequence, Slice 1), §29 (Locked Pre-Build Decisions); `docs/KEMFAI_Blueprint_v1.0.txt`; `.specify/memory/constitution.md` v1.0.0.

## Clarifications

### Session 2026-09-13

- **Q**: Is the duration of the trial / pre-payment setup-access window (the period during which a verified-but-unpaid workspace can use company setup, module selection, and the onboarding checklist before subscription activation) a fixed, hard-coded product decision, or must it be configurable?
  **A**: Not hard-coded. Per Constitution Principle I (P-07, Configuration over hard-coding) and the plan → feature → limit entitlement structure (FR-030), the trial/setup-access window duration, and whether an unpaid workspace is auto-restricted once that window elapses, are entitlement/plan configuration data. A Super Admin or Billing Admin sets and changes these values per plan from the KEMFAI admin dashboard, with no code change required. Where a plan does not specify a value, the system falls back to a documented default of 14 days; a plan may also disable the auto-restriction behavior entirely.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Select a plan and create a verified account (Priority: P1)

A prospective customer visits the public site, compares plans, chooses one, and creates an account with a business email and password. They verify their email before gaining any workspace access, and are offered the ability to turn on multi-factor authentication (MFA) for the account.

**Why this priority**: This is the entry point for every paying customer. No other onboarding step can happen until an identity exists and is verified. It is also the first place the product must prove it is not a security liability for a financial SaaS.

**Independent Test**: Can be fully tested by completing plan selection and signup with a real-looking email, confirming that no workspace or tenant exists until the verification link is used, and that the account cannot log in to anything beyond a "verify your email" state until verified. Delivers value on its own: a verified, plan-associated identity ready for provisioning.

**Acceptance Scenarios**:

1. **Given** the public plan list is displayed with monthly/annual pricing and feature summaries drawn from entitlement data, **When** a visitor selects a plan and billing cycle, **Then** the choice is carried into the signup step without requiring re-entry.
2. **Given** a visitor on the signup form, **When** they submit a business email, password, and accept the required legal terms, **Then** the system creates an unverified account and sends a verification email, and no tenant/workspace is created yet.
3. **Given** an unverified account, **When** the user clicks a valid, unexpired verification link, **Then** the account becomes verified and the user is routed to continue onboarding.
4. **Given** a verified account, **When** the user opts to enable MFA, **Then** the system walks them through MFA enrollment and confirms it is active before returning to onboarding.
5. **Given** an unverified account, **When** the user requests the verification email again, **Then** a new link is sent and any previously issued link for that account is invalidated.
6. **Given** someone attempts to sign up with an email already registered and verified, **When** they submit the form, **Then** the system rejects the duplicate and directs them to sign in or reset their password, without revealing which specific accounts exist beyond that generic message.

---

### User Story 2 - Automatic tenant, workspace, and initial company provisioning (Priority: P1)

Immediately after a customer verifies their email, the system automatically creates their own isolated tenant/workspace, including a dedicated database and an initial (empty) company record, with no manual intervention.

**Why this priority**: Database-per-tenant isolation is a locked, non-negotiable constitutional requirement (Constitution Principle IV; Spec §29). Every later onboarding step operates inside this tenant, so it must exist and be verifiably isolated before setup can proceed.

**Independent Test**: Can be fully tested by verifying an account and confirming a new tenant/workspace and dedicated database are created, that the initial company shell exists, that the acting user is the workspace owner, and that no data or identifiers from any other tenant are visible or reachable from the new workspace.

**Acceptance Scenarios**:

1. **Given** a newly verified account, **When** provisioning completes, **Then** a new tenant/workspace with its own dedicated database and one initial company record exists, and the verified user is assigned the workspace owner role.
2. **Given** two different customers who verified their accounts, **When** either customer's workspace is inspected, **Then** it contains only that customer's tenant identifier, company, and data — no records, identifiers, or configuration from the other tenant are visible through any customer-facing surface.
3. **Given** provisioning is in progress, **When** the user's session polls or refreshes onboarding status, **Then** the user sees a clear "setting up your workspace" loading state rather than an error or a blank screen.
4. **Given** a provisioning attempt fails (e.g., dedicated database creation error), **When** the failure occurs, **Then** the user sees an actionable error state (retry or contact support) and the system records a failed-provisioning audit event without leaving a partially-usable, unisolated workspace active.
5. **Given** a provisioning request is retried after a transient failure, **When** it is retried, **Then** it does not create duplicate tenants, duplicate databases, or duplicate initial companies for the same verified account (idempotent provisioning).

---

### User Story 3 - Configure the company through the setup wizard (Priority: P1)

The workspace owner completes a guided setup wizard to define the company's country, company identity, base currency, fiscal year, VAT/tax registration, industry, and initial accounting setup choices, entirely in KEMFAI's own UI in either English or Arabic with full right-to-left (RTL) support for Arabic.

**Why this priority**: Every later financial slice (chart of accounts, tax, reporting) depends on these company-level settings being captured correctly once, up front. It is also the first place a customer works inside their provisioned tenant, so it is the proving ground for "no native Odoo UI" and full bilingual/RTL support.

**Independent Test**: Can be fully tested against a tenant that has already completed Story 2's provisioning, by stepping through the wizard in both English and Arabic, confirming every field persists, the layout fully mirrors in RTL, and no screen exposes native Odoo UI, URLs, or terminology.

**Acceptance Scenarios**:

1. **Given** a freshly provisioned company with no setup data, **When** the owner opens the setup wizard, **Then** it presents country, company identity, base currency, fiscal year, VAT/tax, industry, and accounting setup steps in a fixed logical order with clear progress indication.
2. **Given** the wizard is displayed with the interface language set to Arabic, **When** any wizard screen renders, **Then** text direction, form field alignment, icons, and navigation controls are fully mirrored to RTL, and all labels/help text are in Arabic.
3. **Given** the owner completes a step and moves to the next, **When** they navigate back, **Then** previously entered values are preserved and editable.
4. **Given** the owner closes the browser mid-wizard, **When** they return later, **Then** the wizard resumes at the first incomplete step with all prior answers intact.
5. **Given** the owner selects a country, **When** country-dependent fields (e.g., VAT/tax registration format) are shown, **Then** the fields and validation rules reflect that country's expected format.
6. **Given** the owner submits an invalid value (e.g., malformed VAT number, missing required field), **When** they attempt to proceed, **Then** the system blocks progression and shows a field-level, localized error message.
7. **Given** the owner completes all required wizard steps, **When** they submit the final step, **Then** the company record is marked "setup complete," the values become editable later from company settings, and an audit event records the completion.

---

### User Story 4 - Select modules and features for the workspace (Priority: P2)

The workspace owner chooses which functional modules/features (e.g., Accounting, Sales, Purchases, Inventory, Projects, Budgeting) to enable, constrained by what the selected plan's entitlements allow.

**Why this priority**: Module selection shapes what the customer sees next (onboarding checklist, navigation) but the workspace is still usable and testable without it by defaulting to a minimal feature set, so it is valuable but not as foundational as identity, tenancy, or company setup.

**Independent Test**: Can be fully tested against a company that has finished the setup wizard, by presenting the module list, attempting to select a module outside the plan's entitlements, and confirming the system blocks or upsells rather than silently enabling it.

**Acceptance Scenarios**:

1. **Given** a company that finished company setup, **When** the owner opens module/feature selection, **Then** available modules are shown with a clear indicator of which are included in the current plan and which require an upgrade.
2. **Given** the owner selects a set of included modules and confirms, **When** the selection is saved, **Then** the workspace's enabled-feature set updates immediately and is reflected in later navigation and the onboarding checklist.
3. **Given** the owner attempts to enable a module not covered by the current plan's entitlements, **When** they attempt to select it, **Then** the system prevents activation and explains which plan tier includes it.
4. **Given** the owner revisits module selection after initial setup, **When** they change the selection, **Then** the change is applied, is subject to the same entitlement checks, and is recorded as an audit event.

---

### User Story 5 - Submit manual bank-transfer payment proof for activation (Priority: P1)

The customer views KEMFAI's bank-transfer payment instructions and a unique payment reference for their subscription, then uploads proof of payment (e.g., transfer receipt) and submits it for review.

**Why this priority**: Until billing is resolved, the subscription cannot become active, per the locked V1 billing decision (Spec §29). This is the customer-facing half of the only supported billing path at launch and must exist before any subscription can move out of a pending state.

**Independent Test**: Can be fully tested against a workspace with a pending subscription, by displaying instructions/reference, uploading a proof document, submitting it, and confirming the submission enters a "pending review" state visible to the customer without needing the admin side to act.

**Acceptance Scenarios**:

1. **Given** a subscription awaiting payment, **When** the customer opens the billing screen, **Then** they see the bank-transfer instructions, the amount and currency due, the billing period, and a unique payment reference tied to their tenant and subscription.
2. **Given** the customer has made the transfer, **When** they upload a supported proof document (e.g., PDF or image receipt) and submit the reference, **Then** the system stores the proof, timestamps the submission, and moves the subscription to "Pending Review."
3. **Given** a submission is "Pending Review," **When** the customer checks their billing screen, **Then** they see the current status, submission date, and cannot submit a duplicate active request for the same billing period until the existing one is resolved.
4. **Given** the customer uploads a file of an unsupported type or over the allowed size, **When** they attempt to submit, **Then** the system rejects the file with a clear, localized error and does not create a pending submission.
5. **Given** a submission was returned as "Request More Information," **When** the customer resubmits with updated proof and/or reference, **Then** the new submission replaces the pending state and preserves the history of the prior request in the audit trail.

---

### User Story 6 - Billing Admin reviews and decides on payment submissions (Priority: P1)

An internal KEMFAI Billing Admin reviews a customer's submitted payment proof and reference against the expected instructions and either approves (activating or renewing the subscription), rejects, or requests more information — with every decision fully audited.

**Why this priority**: This closes the loop that Story 5 opens and is the only mechanism by which a subscription can become Active at launch (Spec §29, locked). Without it, no customer can move from provisioning to a usable, billed subscription.

**Independent Test**: Can be fully tested by seeding a "Pending Review" submission and having a Billing Admin approve, reject, or request more information on it, independent of whether the originating customer flow (Story 5) is re-run each time.

**Acceptance Scenarios**:

1. **Given** one or more submissions in "Pending Review," **When** a Billing Admin opens the review queue, **Then** each submission shows customer, tenant, plan, billing period, amount, currency, bank reference, and proof document for inspection.
2. **Given** a submission that matches expected payment details, **When** the Billing Admin approves it, **Then** the subscription is activated (or renewed) for the billing period, restricted access to the tenant is lifted, and an audit record captures reviewer, decision, and timestamp.
3. **Given** a submission that does not match expected payment details or is otherwise invalid, **When** the Billing Admin rejects it, **Then** the customer is notified with the reason, the subscription remains unactivated, and the decision is audited.
4. **Given** a submission that is unclear or incomplete, **When** the Billing Admin requests more information, **Then** the customer is notified of what is needed, the submission returns to a customer-actionable state, and the request is audited.
5. **Given** an approved activation, **When** the audit record is inspected, **Then** it includes at minimum: customer, tenant, plan, billing period, amount, currency, bank reference, proof document, reviewed by, reviewed at, activation decision, activated by, activated at, notes, and status history (Spec §29).
6. **Given** a Billing Admin attempts to approve a submission for a tenant/subscription combination that is already Active for that billing period, **When** they attempt the action, **Then** the system blocks the duplicate activation and surfaces the existing active state.

---

### User Story 7 - Track onboarding progress via checklist (Priority: P2)

The workspace owner sees a persistent onboarding checklist tracking readiness across adding a customer, adding a bank, adding a product/service, and being ready to issue a first invoice, so they always know what is left before the workspace is fully usable.

**Why this priority**: The checklist is a guidance and confidence-building layer on top of capabilities delivered by other stories; it adds significant clarity but the underlying setup/provisioning/billing flows are usable without it, so it can ship slightly after the flows it tracks.

**Independent Test**: Can be fully tested by manipulating the underlying readiness signals (customer exists, bank exists, product/service exists, invoice-readiness preconditions met) and confirming the checklist reflects each state change without requiring the later slices that actually create invoices.

**Acceptance Scenarios**:

1. **Given** a newly provisioned workspace, **When** the owner views the onboarding checklist, **Then** it lists each readiness item (customer, bank, product/service, first-invoice readiness) as incomplete with a direct link to act on it.
2. **Given** the owner completes one readiness item (e.g., adds a bank account record), **When** the checklist is next viewed, **Then** that item shows complete without requiring a page reload initiated for that sole purpose.
3. **Given** all prerequisite items (customer, bank, product/service) are complete, **When** the checklist evaluates first-invoice readiness, **Then** it marks that item ready and indicates the workspace has met the minimum bar to begin invoicing once available.
4. **Given** the subscription is not yet Active, **When** the owner views the checklist, **Then** it clearly indicates that full usage (e.g., issuing a first invoice) is gated on subscription activation, without blocking the rest of setup.

---

### User Story 8 - Grant, use, and audit time-limited customer support access (Priority: P3)

A customer explicitly grants a KEMFAI support role temporary access to their workspace for troubleshooting; the grant automatically expires and every access event during the grant is logged.

**Why this priority**: This is a trust and compliance safeguard rather than a step every customer passes through during onboarding, so it is valuable but lower priority than the core signup-to-billing path for an initial slice.

**Independent Test**: Can be fully tested by having a customer issue a support-access grant with an expiry, having a support-role account access the workspace within that window, confirming access is refused after expiry, and confirming every action is captured in an audit log — independent of any other onboarding story.

**Acceptance Scenarios**:

1. **Given** a workspace owner wants to get help, **When** they create a support-access grant, **Then** they must choose or confirm an expiry time, and the system records who granted access, to which internal role, and until when.
2. **Given** an active, unexpired grant, **When** an authorized support-role user accesses the workspace under that grant, **Then** their actions are scoped to what the grant permits and are individually logged.
3. **Given** a grant's expiry time has passed, **When** any support-role user attempts to use it, **Then** access is refused and the attempt is logged.
4. **Given** an active grant, **When** the workspace owner revokes it early, **Then** access ends immediately and the revocation is audited.
5. **Given** a completed or expired grant, **When** the owner or an authorized internal auditor views the workspace's support-access history, **Then** every past grant, its granter, expiry, usage, and revocation (if any) is visible.

---

### Edge Cases

- What happens when a visitor selects a plan that is unpublished or removed by the time they reach checkout/signup? The system must detect this and prompt re-selection rather than silently proceeding with stale plan data.
- What happens when a verification link is used twice, or after a newer link has been issued for the same account? Only the most recently issued, unexpired link is honored; earlier ones are treated as invalid.
- How does the system handle a signup attempt with an email that exists but is still unverified? The system re-sends verification rather than creating a second account.
- What happens if the interface language is switched mid-signup or mid-wizard? In-progress, unsaved input on the current step is preserved and the screen re-renders fully mirrored (RTL for Arabic) without data loss.
- How does the system handle a tenant provisioning failure after the workspace record is created but before the dedicated database finishes provisioning? The workspace must not be presented to the user as ready; provisioning is retried or surfaced as failed, and no cross-tenant fallback or shared-database fallback is ever used.
- What happens when two setup-wizard sessions for the same company are open in different tabs/devices? The later save wins per field, and the user is not silently shown stale data without indication.
- How does the system handle an invalid or unsupported file type/size for payment proof upload? The upload is rejected before creating a pending review, with a clear reason shown to the customer.
- What happens when a Billing Admin requests more information multiple times in a row on the same billing period? Each cycle is captured individually in status history, and the customer always sees the latest request.
- What happens if a customer attempts to submit a new proof while a prior submission for the same billing period is still "Pending Review"? The system blocks a second concurrent submission for the same period until the existing one is resolved.
- How does the system prevent a support-access grant from silently outliving its stated purpose? Expiry is enforced automatically with no reliance on a human remembering to revoke it, and the system logs enforcement (successful block) at the moment of an expired-access attempt.
- What happens when someone attempts to access a URL or resource belonging to a different tenant than the one their session is scoped to? Access is denied and the attempt is recorded as an audit/security event.
- What happens when module/feature selection is attempted for a module the current plan does not entitle, via a direct request rather than the UI (e.g., replaying a request)? The entitlement check is enforced server-side regardless of client path, and the attempt is rejected the same way.
- What happens when a company setup wizard field's country-specific validation rule is missing for a launch country? The step must not silently accept unvalidated data; it surfaces a configuration gap rather than a false "valid" acceptance.
- What happens when the onboarding checklist's underlying readiness item (e.g., the sole bank account) is later deleted? The checklist reverts that item to incomplete rather than remaining permanently "done."

## Requirements *(mandatory)*

### Permissions & Tenant/Company Scope

- **FR-001**: System MUST scope every record created during onboarding (account, tenant, workspace, company, module selection, subscription, payment submission, support-access grant, checklist state) to exactly one tenant, with an explicit, immutable tenant identifier — no record MUST be readable or writable across tenant boundaries through any customer-facing surface.
- **FR-002**: System MUST recognize, at minimum, the following customer-side roles established at signup/setup time: Workspace Owner (assigned automatically to the verifying user) and any additional roles the owner explicitly assigns during or after onboarding, drawn from the customer role/permission foundation (Spec §2).
- **FR-003**: System MUST recognize, at minimum, the following internal KEMFAI roles relevant to this feature: Billing Admin (review/approve/reject/request-more-information on payment submissions), Support (may hold customer-granted, time-limited workspace access), and Super Admin/Customer Success/Technical Admin as read/administrative roles over tenant and subscription records, per Spec §2's internal role list.
- **FR-004**: System MUST enforce that only a Billing Admin (or a role with equivalent permission) can approve, reject, or request more information on a payment submission; a customer MUST NOT be able to self-approve their own subscription activation.
- **FR-005**: System MUST enforce that only an authorized internal support-role account, and only while an unexpired, unrevoked grant from the workspace owner exists, can access a customer's workspace for support purposes.
- **FR-006**: System MUST enforce entitlement and permission checks identically regardless of which client surface initiates the action (UI, API, or replayed request).

### Audit Events

- **FR-007**: System MUST record an audit event for, at minimum: account creation, email verification, MFA enrollment, tenant/workspace provisioning (attempt, success, failure), company setup completion, module/feature selection changes, each payment-proof submission, each Billing Admin decision (approve/reject/request-more-information) with reviewer identity and timestamp, subscription activation/renewal, support-access grant creation, support-access usage, support-access expiry/revocation, and any denied cross-tenant access attempt.
- **FR-008**: Every audit event MUST capture, at minimum, the acting identity (or "system" for automated actions), the tenant/company scope, the action taken, and a timestamp; audit events MUST be immutable once written (append-only).
- **FR-009**: The audited record for a manual billing activation decision MUST include, at minimum: customer, tenant, plan, billing period, amount, currency, bank reference, proof document reference, reviewed by, reviewed at, activation decision, activated by, activated at, notes, and status history (Spec §29).

### Empty, Error & Loading States

- **FR-010**: System MUST present a distinct, localized loading state whenever tenant/workspace provisioning, company setup submission, module selection save, payment-proof submission, or a Billing Admin decision is in progress, so the user is never left looking at an unexplained blank or frozen screen.
- **FR-011**: System MUST present a distinct empty state for the plan list (if none are published), the module/feature selection list (if none are available under the current plan), the onboarding checklist (before any item is started), and the support-access history (before any grant exists).
- **FR-012**: System MUST present actionable, localized error states for signup validation failures, verification-link failures (expired/invalid/reused), provisioning failures, setup-wizard validation failures, payment-proof upload failures (unsupported type, size, unreadable), and denied support-access attempts — each error MUST state what went wrong and, where applicable, the next step available to the user.

### Accessibility

- **FR-013**: All screens delivered by this feature (public plan pages, signup/verification/MFA, setup wizard, module selection, billing/payment-proof screens, Billing Admin review queue, onboarding checklist, support-access grant/history) MUST be fully operable via keyboard alone and expose correct semantic roles/labels for assistive technology.
- **FR-014**: All screens delivered by this feature MUST render correctly and fully mirrored in both left-to-right (English) and right-to-left (Arabic) layouts, including form controls, navigation, icons, dates, and numerals, with no untranslated or truncated text in either language.
- **FR-015**: Error, warning, and status indicators (e.g., "Pending Review," "Request More Information," expired grant) MUST be conveyed through text/labels, not color alone, so they remain understandable without relying on color perception.

### Functional Requirements

- **FR-016**: System MUST present a public plan-selection surface listing available plans with monthly and annual pricing and the feature/limit summary sourced from entitlement data, without requiring an account to view it.
- **FR-017**: System MUST carry the visitor's plan and billing-cycle choice through to account signup without requiring re-entry.
- **FR-018**: System MUST allow a visitor to sign up using an email address and password, and MUST reject signups with malformed emails, weak passwords (by a documented minimum standard), or emails already registered and verified.
- **FR-019**: System MUST send an email verification link upon signup and MUST NOT grant access to any tenant/workspace resource until that account's email is verified.
- **FR-020**: System MUST allow a verified account to enroll in multi-factor authentication (MFA) as an available capability; enrollment MUST NOT be a blocking requirement to proceed with onboarding unless a future policy mandates it.
- **FR-021**: System MUST allow an unverified account to request a new verification email, invalidating any previously issued, unused link for that account.
- **FR-022**: System MUST automatically create exactly one tenant/workspace and exactly one initial company record upon successful email verification, with no manual/internal action required.
- **FR-023**: System MUST provision a dedicated, isolated database for each tenant; no two tenants MUST ever share an accounting database, and this provisioning MUST be idempotent (a retried provisioning request for the same verified account MUST NOT create duplicate tenants, databases, or companies).
- **FR-024**: System MUST make the entire onboarding experience (public site through checklist) available in both English and Arabic, selectable by the user at any point, with the selection persisted for their subsequent sessions.
- **FR-025**: System MUST present a company setup wizard covering, at minimum: country, company identity (legal/trade name and related identity details), base currency, fiscal year definition, VAT/tax registration, industry classification, and initial accounting setup choices.
- **FR-026**: System MUST validate country-dependent fields (e.g., VAT/tax registration format) according to the selected country's expected format before allowing the wizard step to complete.
- **FR-027**: System MUST allow the setup wizard to be paused and resumed, preserving previously entered values, and MUST resume at the first incomplete step.
- **FR-028**: System MUST mark a company "setup complete" only once all required wizard steps are submitted, and MUST allow authorized users to edit those settings afterward through company settings (not by re-running the wizard as the only path).
- **FR-029**: System MUST present module/feature selection constrained to what the active plan's entitlements allow, and MUST prevent enabling any module/feature outside those entitlements, showing which plan tier would include it.
- **FR-030**: System MUST maintain a plan-feature-limit entitlement structure (plan → features → limits) that all entitlement checks in this feature (module selection, and future usage limits) read from, so that entitlement logic is never hard-coded per plan name (Constitution Principle I, P-07; Spec §19).
- **FR-030a**: The duration of the trial/setup-access window during which a verified-but-unpaid workspace may use company setup, module selection, and the onboarding checklist, and whether an unpaid workspace is automatically restricted once that window elapses, MUST be represented as admin-configurable plan/entitlement settings within the same plan → feature → limit structure as FR-030 — set and changed per plan by a Super Admin or Billing Admin, ultimately surfaced through the KEMFAI admin dashboard — and MUST NOT be hard-coded in application logic. Where a plan does not specify a value, the system MUST apply a documented default of 14 days, and MUST support a plan-level option to disable the auto-restriction behavior entirely. Building the admin-dashboard screens to author/edit these values follows the same later-slice boundary as other plan/entitlement authoring UI (see Out of Scope); this feature's obligation is that the values be config-driven and read by every trial/restriction check, not hard-coded, so that later admin UI can manage them without a code change.
- **FR-031**: System MUST display bank-transfer payment instructions, the amount and currency due, the billing period, and a unique payment reference tied to the tenant and subscription whenever a subscription is awaiting payment.
- **FR-032**: System MUST allow the customer to upload a payment-proof document and submit it together with the payment reference, moving the subscription to a "Pending Review" state.
- **FR-033**: System MUST prevent a customer from having more than one active, unresolved payment submission for the same tenant and billing period at a time.
- **FR-034**: System MUST provide a Billing Admin review capability that displays all submitted payment details and the proof document, and allows exactly one of: approve (activate/renew), reject, or request more information.
- **FR-035**: System MUST notify the customer of the outcome of each Billing Admin decision, including the reason for rejection or the specifics of a more-information request.
- **FR-036**: System MUST activate or renew a subscription only through an audited Billing Admin approval decision (or a future automated path explicitly designed to replace it) — never automatically or silently upon proof upload alone.
- **FR-037**: System MUST maintain an onboarding checklist per workspace tracking, at minimum: customer added, bank added, product/service added, and first-invoice readiness, each reflecting the live state of its underlying record(s).
- **FR-038**: System MUST indicate on the onboarding checklist when full usage (e.g., issuing invoices) remains gated on subscription activation, distinct from setup-only readiness.
- **FR-039**: System MUST allow a workspace owner to create a support-access grant for an internal support role that includes a mandatory expiry, and MUST enforce that expiry automatically without requiring manual revocation.
- **FR-040**: System MUST allow a workspace owner to revoke an active support-access grant immediately at any time before its expiry.
- **FR-041**: System MUST log every use of an active support-access grant and every denied attempt to use an expired or revoked grant.
- **FR-042**: System MUST ensure that no screen, redirect, error message, or embedded resource delivered by this feature exposes native Odoo UI, Odoo terminology, or direct Odoo endpoints to the customer.

### Key Entities

- **Plan**: A publicly sellable subscription tier with pricing (monthly/annual) and an associated set of feature/limit entitlements; plans can be published or unpublished.
- **Feature Entitlement**: A named capability or limit (e.g., a module, a usage cap) associated with one or more plans; drives what module selection and future usage checks allow.
- **Account**: A person's login identity (email, credential, verification state, MFA enrollment state); becomes a Workspace Owner or other role holder once associated with a tenant.
- **Tenant/Workspace**: The isolated container for one customer's data, including its dedicated database reference, provisioning state, and subscription reference.
- **Company**: The initial legal/business entity inside a tenant, holding setup-wizard attributes (country, identity, base currency, fiscal year, VAT/tax, industry, accounting setup state).
- **Module/Feature Selection**: The set of modules/features a tenant has chosen to enable, constrained by its plan's entitlements.
- **Subscription**: The billing relationship between a tenant and a plan, including billing period, status (e.g., Pending Activation, Active, Suspended), and history of activations/renewals.
- **Payment Submission**: A customer-submitted claim of payment for a billing period, including bank reference, proof document reference, status (Pending Review, Approved, Rejected, More Information Requested), and its full status history.
- **Support Access Grant**: A customer-authorized, time-bounded permission for an internal support role to access a specific tenant, with granter, grantee role, expiry, revocation state, and usage log.
- **Onboarding Checklist Item**: A per-tenant readiness signal (customer, bank, product/service, first-invoice readiness) derived from underlying records rather than stored as an independent source of truth.
- **Audit Event**: An immutable record of a significant action, capturing actor, tenant/company scope, action, and timestamp, linked to the entity it concerns.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new visitor can move from selecting a plan to receiving a verification email in under 2 minutes of active effort.
- **SC-002**: At least 90% of accounts that complete signup also complete email verification within 24 hours.
- **SC-003**: A verified customer's tenant/workspace and initial company become usable within 5 minutes of verification, without any manual/internal step.
- **SC-004**: 100% of automated tenant-isolation tests confirm zero cross-tenant data visibility across any customer-facing surface.
- **SC-005**: 100% of onboarding screens (public site through checklist) render correctly and fully mirrored in both English/LTR and Arabic/RTL, with no untranslated or clipped content.
- **SC-006**: At least 80% of workspace owners who start the company setup wizard complete it without contacting support.
- **SC-007**: 100% of manual billing activation decisions have a complete, retrievable audit record containing every field required by Spec §29 at the moment the decision is made.
- **SC-008**: A Billing Admin can review and decide on a submitted payment proof in under 5 minutes of active review time per submission.
- **SC-009**: 100% of support-access grants that reach their expiry are automatically inaccessible within 1 minute of expiry, with zero manual revocation required.
- **SC-010**: 100% of onboarding-checklist item states match the live state of their underlying record when checked immediately after that record changes.
- **SC-011**: Zero instances, across acceptance testing, of a customer-facing screen exposing native Odoo UI, terminology, or direct Odoo endpoints.

## Assumptions

- A tenant/workspace, its dedicated database, and an initial company are provisioned immediately upon email verification — before payment is resolved — so the customer can proceed through company setup, module selection, and the onboarding checklist while the subscription is in a pending/trial state. The manual billing lifecycle's "Provision/Enable Tenant Database" step (Spec §29) is treated as lifting access restrictions on an already-provisioned tenant on approval, reconciling it with the general provisioning-after-verification flow in Spec §3. This keeps onboarding self-serve even before a bank transfer clears, while still gating full financial usage (e.g., first invoice) on subscription activation. The length of this pending/trial window, and whether it auto-restricts access on expiry, is not a fixed product decision — it is admin-configurable per plan (see Clarifications, 2026-09-13, and FR-030a), defaulting to 14 days where a plan sets no explicit value.
- MFA is offered as an available capability the user can enable at or after signup, not a mandatory precondition for account creation, consistent with the source spec's phrasing "require MFA capability" (Spec §27) rather than "require MFA."
- "First invoice readiness" in the onboarding checklist means all prerequisites are met (customer, bank, product/service exist), not that an actual invoice is created or posted — invoice creation and posting are delivered in a later slice (Accounting Core / Sales & AR).
- "Accounting setup" within the company setup wizard refers to initial, high-level choices (e.g., an initial chart-of-accounts template and fiscal-year-driven period structure) captured for later slices to build on, not the full chart-of-accounts configuration itself, which is out of scope for this feature.
- The customer role/permission catalog referenced (Workspace Owner and other roles) draws its names from the role foundation in Spec §2; this feature establishes the roles/scopes skeleton but does not need to expose every permission verb (View/Create/Edit/Post/Approve/Pay/Reverse/Export) against every financial object, since those objects do not exist until later slices.
- Password and session security follow standard industry practice (minimum complexity, rate-limited attempts, secure session handling) absent more specific numeric requirements in the source documents.
- Supported payment-proof file types are common document/image formats (e.g., PDF, PNG, JPG) with a reasonable maximum size; exact values are an implementation-time detail, not a business rule fixed by this specification.
- Migration path selection (Start Fresh / Excel / QuickBooks / Odoo), covered by Spec §3 step 7, is a distinct later step in the broader customer journey and is intentionally excluded from this slice's scope.

## Out of Scope

- Actual accounting functionality: chart of accounts configuration beyond an initial template choice, journals, invoices, bills, banking reconciliation, projects, budgeting, inventory, and financial reporting are delivered in later slices (Spec §28, Slices 2+).
- Migration Wizard (Start Fresh / Excel / QuickBooks / Odoo import) and any data migration/reconciliation tooling.
- Automated/online payment processing (e.g., card checkout, Stripe integration); this feature covers only the manual bank-transfer lifecycle locked for V1 (Spec §29). Billing Phase 2 automation is explicitly out of scope.
- Full role/permission-verb matrix (View/Create/Edit/Post/Approve/Pay/Reverse/Export) against financial objects — this feature only establishes the roles/scopes foundation needed for onboarding and billing actors.
- KEMFAI Super Admin console features beyond what Billing Admin needs to review/approve/reject/request-more-information on payment submissions (e.g., plan/pricing authoring UI, trial/setup-access-window and unpaid-restriction configuration screens, coupons, revenue/MRR dashboards, system health) — this feature only requires that those values exist as config-driven entitlement data (FR-030, FR-030a), not that this slice deliver the screens to author them.
- Country-specific government e-invoicing/tax-authority connectors (UAE, KSA, Egypt); only the country-driven setup-wizard fields (e.g., VAT/tax registration capture) are in scope.
- Actual support-session tooling (e.g., screen-share, impersonation UI) beyond the grant/expiry/audit data model and access enforcement.
- Password-recovery/account-recovery flows beyond what is required to complete email verification and basic sign-in (treated as standard platform capability, not specified here in detail).
- Mobile-specific experiences; this feature specifies behavior independent of device form factor but does not define native mobile app scope.
