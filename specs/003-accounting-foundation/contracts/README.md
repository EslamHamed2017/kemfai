# Accounting Foundation API Contract v1

Canonical machine-readable contract: [`openapi.yaml`](./openapi.yaml).

## Scope

This contract exposes only policy-independent Stories 1–3:

- compact chart of accounts;
- dimension definitions, values, and rules;
- journals and company currency configuration;
- non-posting journal drafts and policy-independent draft validation.

There is deliberately **no** endpoint to post, reverse, post openings, approve policy, or transition/enforce periods. Those operations belong to a future reviewed contract after Finance Owner approval. A client must never infer posting permission from a successful draft validation; the response vocabulary is `valid_for_draft` and `ledgerEffect: none`.

## Security and scope

All operations require a verified bearer token. Tenant is derived server-side from that identity. `X-KEMFAI-Company-Id` is a KEMFAI UUID and is resolved/authorized within the exact routed tenant database. It is not an Odoo company ID. Cross-scope/not-found responses are intentionally non-disclosing.

Every mutation, including draft validation, requires `Idempotency-Key`. Same scoped key and fingerprint replays the original `operationId`, `auditEventId`, `correlationId`, result, and `replayed=true`; altered-key reuse returns `409`. Updates require `If-Match: "<version>"` and stale/missing targets return `412`. Currency PUT is explicit: `If-Match: *` is create-only; a strong ETag is update-only. Successful mutations return the current ETag (where versioned) and a mutation/audit receipt; request/domain validation returns `422`. Tenant receipt/audit is in the same Odoo transaction and failure rolls back the mutation. Platform-audit mirror failure withholds success until recoverable dedupe completes. Localized UI strings are selected in the frontend from stable error/message keys; stored numeric and identity values do not vary by locale.

## Compatibility

- Base path version: `/v1/accounting`.
- Additive optional response fields are compatible within v1.
- New required request fields, changed enum meaning, or any posting operation require a new reviewed revision/version.
- OpenAPI schemas use exact decimal strings rather than JSON floating-point numbers. Every line names transaction/base currency codes and precision metadata. Native decimal places are read-only descriptive metadata, not mutable rounding policy; over-scale values are saved exactly and reported as policy blockers.
- Foreign-currency lines require non-null rate reference/effective date; base-currency lines explicitly carry null. The server selects no source/date policy and calculates neither rate nor base amount.

## Required contract tests

1. Every documented path/verb is mounted and conforms to schemas/error envelopes.
2. No path/operation contains post-entry, reversal, opening-post, approval, or period-transition behavior.
3. Every accounting operation requires bearer auth and company context.
4. Every mutation enforces idempotency, returns an audit receipt, uses `409` for altered-key reuse, `412` for stale conditional updates, and `422` for validation; every update requires the documented precondition and returns ETag.
5. Currency create/update distinguishes `If-Match: *` from strong ETag and permits only enable/disable mutation.
6. A successful validation mutation has a receipt, complete configuration/native-metadata snapshot, base currency/precision totals, `ledgerEffect: none`, and cannot yield `valid_for_post`; audit failure is fail-closed.
7. Draft save round-trips exact over-scale strings, conditional FX metadata is enforced with stable codes, and no rate/base amount is calculated.
8. Public payloads contain no Odoo model name, integer record ID, DB name, RPC URL, or raw engine exception.
