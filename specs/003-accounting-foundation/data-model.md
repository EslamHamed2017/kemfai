# Data Model: KEMFAI Accounting Foundation

**Scope:** Full conceptual model, with Stories 1–3 implemented first. Story 4–7 entities/fields are marked **GATED** and cannot drive production behavior before Finance Owner policy approval and later design review.

## Ownership and Identity Invariants

- Tenant is derived from authenticated identity and maps to exactly one Odoo database. No accounting row is stored in `kemfai_control`.
- Every record below belongs to one `company_id` unless explicitly global native currency metadata; all cross-record links must match company and routed tenant DB.
- Public IDs are immutable UUIDs. Odoo integer IDs and tenant DB names never cross the API boundary.
- Mutations use `version` (integer, starts 1) plus operation UUID/receipt. Deactivation preserves references; ordinary destructive delete is prohibited after any reference.
- Stored labels support `name_en` and `name_ar`; locale selects presentation only and never changes identifiers, amounts, or relationships.

## Existing Context Entities

### Tenant (control-plane routing only)

Existing registry fields `id`, `odoo_db_name`, and `odoo_company_id` are reused. It stores no accounting values. The authenticated subject resolves tenant server-side.

### Company (native `res.company`, extended)

| Field | Type | Rule |
|---|---|---|
| `kemfai_public_id` | UUID | Immutable, unique within tenant DB; public company context. |
| `currency_id` / existing setup base currency | FK `res.currency` | One base currency; changing after financial history is not an ordinary Story 1–3 edit. |
| `timezone`, fiscal inputs | existing/config | Used for dates; no period action policy inferred. |

## Story 1 — Chart of Accounts

### Account (extends native `account.account`)

| Field | Type | Rule |
|---|---|---|
| `kemfai_public_id` | UUID | Immutable public ID; unique. |
| `company_id` | FK Company | Required effective owner even if native Odoo uses a multi-company relation; KEMFAI methods expose one-company ownership. |
| `code` | string | Required; unique per company; stable historical display. |
| `name_en`, `name_ar` | string | Required bilingual labels. |
| `account_type` | native selection | Accounting classification; not a dimension. |
| `kemfai_node_kind` | enum `parent, posting` | Explicit. Parent is never line-selectable. |
| `kemfai_parent_id` | FK Account? | Same company, no self/cycle; parent target must be `parent`. |
| `active` | boolean | Inactive remains readable historically but unavailable to new draft lines. |
| `version` | integer | Increment under lock on accepted mutation. |
| `created/updated_by`, timestamps | audit metadata | Actor references are KEMFAI identity strings/UUIDs. |

**Constraints/state:**
- `(company_id, code)` unique; parent graph acyclic.
- Posting→parent conversion or reparenting is rejected when it invalidates existing drafts/history/children.
- `unlink` is blocked for referenced/history records; API offers deactivate, not DELETE.
- Account selection accepts only active `posting` records in current company.

## Story 2 — Dimensions

### DimensionDefinition (`kemfai.dimension.definition`)

| Field | Type | Rule |
|---|---|---|
| `public_id` | UUID | Immutable. |
| `company_id` | FK Company | Required applicability. |
| `key` | string | Unique/company. Seeded keys: entity, branch, department, cost_center, project, salesperson. Custom keys are data. |
| `kind` | enum `built_in, custom, tag` | Does not encode policy. |
| `name_en`, `name_ar` | string | Required. |
| `active`, `version` | bool/int | Optimistic mutation. |

### DimensionValue (`kemfai.dimension.value`)

| Field | Type | Rule |
|---|---|---|
| `public_id`, `company_id` | UUID/FK | Immutable ID; one company. |
| `definition_id` | FK Definition | Same company and active for new selection. |
| `code` | string | Unique within definition/company. |
| `name_en`, `name_ar` | string | Required. |
| `active`, `version` | bool/int | Deactivation retains existing draft display but requires revalidation. |
| `linked_object_type/id` | optional internal reference | Future adapter for Project/Entity without changing public dimension assignment; never a raw public Odoo reference. |

### DimensionRule (`kemfai.dimension.rule`)

| Field | Type | Rule |
|---|---|---|
| `public_id`, `company_id` | UUID/FK | One company. |
| `account_id` | FK Account? | Optional target; same company. |
| `transaction_type_key` | string? | Optional configured context, e.g. `manual_journal`; not a policy action table. |
| `dimension_definition_id` | FK Definition | Required dimension category. |
| `requirement` | enum `required, optional, prohibited` | Data-driven validation. |
| `effective_from`, `effective_to` | date? | Non-overlapping deterministic applicability. |
| `active`, `version` | bool/int | Stale writes rejected. |

At least one of account or transaction type is present. Conflicting equally specific active rules are rejected, not silently ordered. Rule resolution output records exact rule public IDs/versions.

### DraftDimensionAssignment (`kemfai.account.draft.dimension`)

Unique `(draft_line_id, definition_id)`, linking one scoped active value. Existing inactive values remain readable but make current validation fail until corrected.

## Story 3 — Journals and Currency Configuration

### Journal (extends native `account.journal`)

| Field | Type | Rule |
|---|---|---|
| `kemfai_public_id`, `company_id` | UUID/FK | Immutable ID; one company. |
| `code`, `name_en`, `name_ar` | strings | Code unique/company, localized labels. |
| `journal_type` | constrained native value | Manual/general journal is in safe scope; no transaction-module behavior implied. |
| `active`, `version` | bool/int | Inactive unavailable for new drafts; history retained. |

### CurrencyConfiguration (`kemfai.account.currency.config`)

| Field | Type | Rule |
|---|---|---|
| `public_id`, `company_id` | UUID/FK | Unique public ID/company. |
| `currency_id` | FK native `res.currency` | Unique/company; immutable through this API. |
| `currency_code` | read-only native metadata | ISO code exposed from `res.currency`; immutable through this API. |
| `native_decimal_places` | read-only native metadata | Descriptive decimal-place metadata only; never an owner-approved rounding rule. |
| `native_metadata_version` | immutable/versioned metadata token | Identifies the exact native code/decimal-place snapshot independently of config version. |
| `is_base` | read-only derived boolean | True iff currency matches the company’s existing base currency; base selection cannot be changed here. |
| `enabled` | boolean | The only currency mutation in this slice; company-specific and does not mutate global currency activity. |
| `version` | integer | Enablement-row version, snapshotted separately from native metadata version. |

There is no mutable precision or rate-reference-policy field. No rate provider/date rule, rounding precision/tolerance/account, base-currency change, or realized/unrealized treatment is chosen here.

## Stories 2–3 — Non-Posting Draft Staging

### JournalDraft (`kemfai.account.draft`)

| Field | Type | Rule |
|---|---|---|
| `public_id`, `company_id` | UUID/FK | One company. |
| `journal_id` | FK Journal | Required, active on save/revalidation. |
| `accounting_date` | date | Company-date input; no period permission conclusion. |
| `description`, `transaction_type_key` | strings | `manual_journal` in current scope. |
| `source_type`, `source_public_id` | optional strings/UUID | Explicit source context; no dead-end raw URL. |
| `status` | enum `draft` | Stories 1–3 have exactly one state; never posted. |
| `version` | integer | Header/line mutation version. |
| `last_validation_id` | FK ValidationRun? | Most recent result. |
| `created_by`, `updated_by`, timestamps | identity/time | Auditable. |

### JournalDraftLine (`kemfai.account.draft.line`)

| Field | Type | Rule |
|---|---|---|
| `public_id`, `draft_id`, `sequence` | UUID/FK/int | Stable line identity/order. |
| `account_id` | FK Account | Same company, posting node. |
| `description` | string | Localized UI label is separate from stored user text. |
| `currency_config_id` | FK CurrencyConfiguration | Same company and enabled. |
| `transaction_currency_code`, `transaction_precision` | code/int | Required exact snapshots of native transaction-currency metadata. |
| `company_base_currency_code`, `base_precision` | code/int | Required exact snapshots of company base/native metadata. |
| `transaction_debit`, `transaction_credit` | authoritative exact decimal strings | Exact submitted lexemes (including trailing zeros) are preserved; any numeric projection is exact-decimal only. Exactly one side is positive or both are zero while incomplete; never float. |
| `base_debit`, `base_credit` | authoritative exact decimal strings | Caller-supplied lexemes (including trailing zeros) are preserved exactly; any numeric projection is exact-decimal only. Required and never calculated by this slice. |
| `rate_reference`, `rate_effective_date` | string/date or explicit null | Both non-null when transaction currency differs from company base; both null for base-currency lines. No source/date policy, lookup, rate, or base calculation is inferred. |
| `account_version`, `journal_version`, `currency_config_version` | integers | Deterministic master/enablement snapshots; stale snapshot forces revalidation. |
| `transaction_currency_metadata_version`, `base_currency_metadata_version` | immutable metadata tokens | Exact native metadata versions, separate from currency config version. |
| `source_context` | JSON object? | KEMFAI identifiers only. |

**Draft invariants:** no row is an `account.move`/posted ledger line; no balance table changes. Draft save accepts and exactly preserves valid decimal scale beyond native decimal-place metadata; it neither rejects, rounds, nor truncates that amount. Validation emits `AMOUNT_SCALE_EXCEEDS_METADATA` as a policy blocker requiring future owner-approved rounding treatment. Missing foreign-currency provenance emits `FX_RATE_REFERENCE_REQUIRED` and/or `FX_RATE_EFFECTIVE_DATE_REQUIRED`; base-currency lines explicitly persist both fields as null. Transaction and base amounts are independently caller-supplied/preserved. Base arithmetic can be reported, but no rate, tolerance, or rounding adjustment is selected or created.

### DraftValidationRun (`kemfai.account.draft.validation`)

| Field | Type | Rule |
|---|---|---|
| `public_id`, `draft_id`, `draft_version` | UUID/FK/int | Immutable result for exact draft version. |
| `status` | enum `valid_for_draft, invalid` | Never `valid_for_post`. |
| `checks_performed` | string array/JSON | Named policy-independent checks. |
| `errors`, `warnings`, `policy_blockers` | structured JSON | Stable codes, optional line/resource UUID, field path, localized-message key/params. |
| `base_debit_total`, `base_credit_total` | exact decimal strings/storage Decimal | Exact preview totals; never float. |
| `company_base_currency_code`, `base_precision` | code/int | Required metadata for both totals. |
| `ledger_effect` | constant `none` | Enforced. |
| `rule_versions`, `configuration_versions` | JSON | Exact IDs and versions for accounts, dimension rules, journal, each currency enablement row, and each separate native currency metadata version/decimal-place snapshot. |
| `validated_by`, `validated_at` | identity/time | Immutable. |

A change to draft/master/rule/configuration or native currency metadata invalidates the current run. Policy blockers include `AMOUNT_SCALE_EXCEEDS_METADATA` for any transaction/base amount whose exact scale exceeds its corresponding metadata precision and `POLICY_APPROVAL_REQUIRED` where a caller asks for a posting-level conclusion; no policy value appears. The validation run is receipt-bearing and auditable; tenant receipt/audit failure rolls it back and no success is returned.

## Cross-Cutting Durability and Audit

### AccountingMutationHandoff (control-plane, no financial data beyond intent envelope)

Fields mirror the proven company handoff: UUID, tenant ID, actor account/principal, exact Odoo DB/company routing, action, request fingerprint/payload (redacted/minimal), operation/idempotency scope, state `pending|odoo_committed|audited`, response, retry count, lease/backoff, timestamps. Unique scoped idempotency key; altered fingerprint conflicts. This is orchestration metadata, not accounting state.

### AccountingMutationReceipt (`kemfai.account.mutation.receipt`, tenant DB)

Unique operation UUID, company, action, request fingerprint, actor, occurred-at, immutable result JSON, audit-event UUID. Written in the same Odoo transaction as the mutation. Replay returns the original result.

### AccountingAuditEvent (`kemfai.account.audit.event`, tenant DB)

| Field | Type | Rule |
|---|---|---|
| `public_id`, `operation_uuid` | UUID | Immutable; operation dedupe. |
| `company_id`, `actor_id` | scope | Required. |
| `action`, `target_type`, `target_public_id` | strings/UUID | KEMFAI vocabulary. |
| `before_json`, `after_json` | JSON | Canonical/redacted state. |
| `outcome`, `reason_code` | strings | Success/denial where evaluated in tenant domain. |
| `correlation_id`, `occurred_at`, `created_at` | strings/timestamps | Unambiguous. |

No ordinary write/unlink access. Platform `audit_event` receives a deduped mirror for search and pre-domain denials. A success response is withheld until handoff reaches `audited`; recovery does not duplicate the tenant event.

## GATED Model — Stories 4–7 (design placeholders only)

These concepts cannot be implemented as active behavior from this plan:

- `JournalEntry`/`JournalLine`: future immutable posted `account.move` mapping with exact matrix version.
- `AccountingPolicyMatrixVersion`: future owner-approved effective values; no rows/seeds/allowed-action values now.
- `SourceLink`: future bidirectional original/reversal/correction/opening links; drafts already reserve safe source context.
- `OpeningBalanceBatch`: future prepare/validate/preview/approve/post state machine.
- `AccountingPeriod` and `PeriodTransition`: future four named states and append-only history; allowed actions remain undefined.

A nullable future-reference column does not authorize behavior. Stories 1–3 create no posted entry, reversal, opening post, or period transition.

## State Transitions

```text
Account/Dimension/Journal: active -> inactive -> active (audited, versioned)
CurrencyConfiguration: enabled -> disabled -> enabled (audited, versioned; base/native metadata immutable)
JournalDraft: draft --edit/validate--> draft (version increments; prior validation stale)
MutationHandoff: pending -> odoo_committed -> audited
                     \-> retry/backoff (nonterminal, lease-owned)
```

No Story 1–3 transition reaches `posted`.
