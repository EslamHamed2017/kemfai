# Contract: Audit Events & Background Job Signals

This complements `openapi.yaml` with the non-HTTP contracts this feature produces: the audit-event catalog
(what every FR-007 action must write) and the background-job/notification signals from research.md §3/§6/§8.
These are contracts for what tasks.md implementation must emit — not implementation code.

## Audit event catalog (AuditEvent.action values)

Every event below carries, at minimum, `actor_type`, `actor_id` (or null for `system`), `tenant_id` (or null
pre-tenant), `subject_type`/`subject_id`, `occurred_at`, and an action-specific `payload` (FR-008).

| action | actor_type | tenant_id | subject | payload highlights |
|---|---|---|---|---|
| `account.created` | account | null | Account | plan_id, billing_cycle |
| `account.email_verified` | account | null | Account | |
| `account.mfa_enrolled` | account | tenant (if assigned) | Account | |
| `tenant.provisioning.attempted` | system | tenant | Tenant | attempt number |
| `tenant.provisioning.succeeded` | system | tenant | Tenant | odoo_db_name |
| `tenant.provisioning.failed` | system | tenant | Tenant | failure_reason |
| `company.setup.completed` | account | tenant | Company | |
| `company.settings.updated` | account | tenant | Company | changed_fields[] — post-completion edits via the distinct company-settings surface (FR-028; F3 remediation, see analysis.md), not the setup wizard |
| `modules.selection.changed` | account | tenant | ModuleSelection | added[], removed[] |
| `billing.payment_submission.created` | account | tenant | PaymentSubmission | bank_reference, amount, currency, billing_period |
| `billing.payment_submission.decided` | internal_user | tenant | PaymentSubmission | decision (approve/reject/more_info), reviewed_by, reviewed_at, notes — full field set per FR-009 |
| `billing.subscription.activated` | internal_user | tenant | Subscription | activated_by, activated_at, billing_period |
| `support_access.grant.created` | account | tenant | SupportAccessGrant | grantee_role, expires_at |
| `support_access.grant.used` | internal_user | tenant | SupportAccessGrant | action_summary |
| `support_access.grant.denied` | internal_user | tenant | SupportAccessGrant | denial_reason (expired/revoked) |
| `support_access.grant.revoked` | account | tenant | SupportAccessGrant | revoked_by |
| `support_access.grant.expired` | system | tenant | SupportAccessGrant | expired via scheduled sweep (research.md §8) |
| `tenant.trial.restricted` | system | tenant | Tenant | trial_window_days, elapsed_days, auto_restrict_unpaid — emitted the first time an unpaid tenant crosses its trial window (FR-030a enforcement; F2 remediation, see analysis.md), by `trial.expiry_sweep` or by `TrialWindowGuard`'s first live denial, whichever occurs first |
| `tenant_access.denied_cross_tenant` | account or internal_user | requesting tenant (the caller's, not the target) | resource attempted | target_tenant_id, resource path |

This table is the acceptance surface for SC-007 ("100% of manual billing activation decisions have a complete,
retrievable audit record") and for the Test Strategy's audit-completeness tests in plan.md.

## Background job / notification signals (BullMQ)

| Job | Trigger | Idempotency key | On success | On failure |
|---|---|---|---|---|
| `tenant.provision` | `account.email_verified` | `account_id` (unique job id) | Tenant → Ready, `tenant.provisioning.succeeded` | Tenant → Failed, `tenant.provisioning.failed`, retryable |
| `email.send_verification` | signup, resend-verification | `account_id` + issued token version | Email dispatched | Retried with backoff; does not block signup response |
| `notification.billing_decision` | `billing.payment_submission.decided` | `submission_id` + decision | Customer notified (FR-035) | Retried with backoff |
| `support_access.expiry_sweep` | Scheduled, every 30s | N/A (sweep, not per-entity) | Expired grants flipped, `support_access.grant.expired` emitted per grant | Logged; next tick self-heals |
| `trial.expiry_sweep` | Scheduled, every 30s | N/A (sweep, not per-entity) | Newly-crossed-threshold unpaid tenants detected, `tenant.trial.restricted` emitted per tenant (F2 remediation — mirrors `support_access.expiry_sweep`) | Logged; next tick self-heals; live `TrialWindowGuard` enforcement is unaffected by a missed tick |

All jobs above are safe to run more than once for the same key (Constitution Principle VII / FR-023) — the
handler for each checks current state before mutating, per research.md §3.
