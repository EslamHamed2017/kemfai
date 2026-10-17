import json
import uuid
from datetime import datetime, timezone

from odoo import api, fields, models
from odoo.exceptions import ValidationError


class KemfaiModuleSelectionLock(models.Model):
    """Single-row write mutex for repeatable-read-safe full-set replacements.

    Updating the row, rather than merely waiting on an advisory lock, makes PostgreSQL
    raise SQLSTATE 40001 for a concurrent transaction whose repeatable-read snapshot was
    established before the preceding writer committed. Odoo's request dispatcher retries
    that transaction with a fresh environment/snapshot, which can then observe the pending
    receipt. This prevents a stale waiter from reaching the one-pending unique constraint.
    """

    _name = 'kemfai.module.selection.lock'
    _description = 'KEMFAI Module Selection Replacement Mutex'
    _log_access = False

    singleton_key = fields.Boolean(required=True, default=True)
    generation = fields.Integer(required=True, default=0)

    _sql_constraints = [
        ('singleton_key_unique', 'unique(singleton_key)', 'Only one selection mutex may exist.'),
        ('singleton_key_true', 'check(singleton_key)', 'The selection mutex key must be true.'),
    ]


class KemfaiModuleSelection(models.Model):
    """Tenant-database cache of the control plane's entitled module selection.

    The tenant is isolated by its dedicated Odoo database. Entitlement decisions are
    deliberately absent here: the BFF resolves them through EntitlementsService before
    invoking ``kemfai_replace_selection``. The method replaces the complete set in one
    Odoo transaction, so callers never observe a partially-applied selection.
    """

    _name = 'kemfai.module.selection'
    _description = 'KEMFAI Module Selection Cache'
    _order = 'feature_key'

    feature_key = fields.Char(required=True, index=True)
    enabled = fields.Boolean(required=True, default=True)
    updated_at = fields.Datetime(required=True, default=fields.Datetime.now)
    updated_by = fields.Many2one('res.users', required=True, default=lambda self: self.env.user)

    _sql_constraints = [
        (
            'feature_key_unique',
            'unique(feature_key)',
            'A feature may occur only once in the tenant module selection.',
        ),
    ]

    @api.model
    def kemfai_get_selection(self):
        return self.search([('enabled', '=', True)]).mapped('feature_key')

    @api.model
    def kemfai_replace_selection(
        self, feature_keys, operation_uuid, tenant_id, account_id,
        actor_keycloak_user_id, occurred_at
    ):
        if not isinstance(feature_keys, list) or any(
            not isinstance(key, str) or not key.strip() for key in feature_keys
        ):
            raise ValidationError(
                'KEMFAI_INVALID_MODULE_SELECTION: feature_keys must be an array of non-empty strings.'
            )

        # This must be the first database operation in the method. A concurrent UPDATE
        # against the singleton makes a stale repeatable-read waiter fail with SQLSTATE
        # 40001; Odoo retries the whole RPC with a fresh snapshot. A read-only advisory
        # lock is insufficient because waiting on it establishes a snapshot that cannot
        # see the preceding writer's newly committed pending receipt.
        self.env.cr.execute(
            'UPDATE kemfai_module_selection_lock '
            'SET generation = generation + 1 '
            'WHERE singleton_key = true '
            'RETURNING generation'
        )
        if self.env.cr.fetchone() is None:
            raise ValidationError('KEMFAI_SELECTION_LOCK_MISSING: replacement mutex is not seeded.')

        normalized = sorted(set(key.strip() for key in feature_keys))
        identity = {
            'operation_uuid': operation_uuid,
            'tenant_id': tenant_id,
            'account_id': account_id,
            'actor_keycloak_user_id': actor_keycloak_user_id,
        }
        try:
            for value in identity.values():
                uuid.UUID(value)
        except (ValueError, TypeError, AttributeError):
            raise ValidationError('KEMFAI_INVALID_SELECTION_IDENTITY: all identity values must be UUIDs.')
        try:
            if not isinstance(occurred_at, str):
                raise ValueError
            wire_time = occurred_at.strip()
            if not wire_time or wire_time != occurred_at:
                raise ValueError
            parsed_time = datetime.fromisoformat(
                wire_time[:-1] + '+00:00' if wire_time.endswith('Z') else wire_time
            )
            if parsed_time.tzinfo is None or parsed_time.utcoffset() is None:
                raise ValueError
            # Odoo persists UTC datetimes without tzinfo. Normalize explicitly so offsets
            # retain the original instant instead of being interpreted as local wall time.
            mutation_time = parsed_time.astimezone(timezone.utc).replace(tzinfo=None)
        except (ValueError, TypeError, OverflowError):
            raise ValidationError(
                'KEMFAI_INVALID_SELECTION_TIME: occurred_at must be an unambiguous '
                'timezone-aware ISO 8601 datetime.'
            )

        requested_json = json.dumps(normalized, separators=(',', ':'))
        pending = self.env['kemfai.module.selection.event'].search(
            [('audited', '=', False)],
            order='created_at asc',
            limit=1,
        )
        if pending:
            return pending.kemfai_payload()

        current = self.search([])
        by_key = {row.feature_key: row for row in current}
        requested = set(normalized)
        before = {row.feature_key for row in current if row.enabled}
        now = fields.Datetime.now()

        for key, row in by_key.items():
            should_enable = key in requested
            if row.enabled != should_enable:
                row.write({'enabled': should_enable, 'updated_at': now, 'updated_by': self.env.uid})

        missing = requested.difference(by_key)
        if missing:
            self.create(
                [
                    {
                        'feature_key': key,
                        'enabled': True,
                        'updated_at': now,
                        'updated_by': self.env.uid,
                    }
                    for key in sorted(missing)
                ]
            )

        event = self.env['kemfai.module.selection.event'].create({
            **identity,
            'requested_json': requested_json,
            'result_json': json.dumps(normalized, separators=(',', ':')),
            'added_json': json.dumps(sorted(requested - before), separators=(',', ':')),
            'removed_json': json.dumps(sorted(before - requested), separators=(',', ':')),
            'occurred_at': mutation_time,
            'created_at': now,
        })
        return event.kemfai_payload()

    @api.model
    def kemfai_ack_selection_event(
        self, operation_uuid, tenant_id, account_id, actor_keycloak_user_id
    ):
        event = self.env['kemfai.module.selection.event'].search(
            [
                ('operation_uuid', '=', operation_uuid),
                ('tenant_id', '=', tenant_id),
                ('account_id', '=', account_id),
                ('actor_keycloak_user_id', '=', actor_keycloak_user_id),
            ],
            limit=1,
        )
        if not event:
            raise ValidationError('KEMFAI_SELECTION_EVENT_CONTEXT_MISMATCH: receipt identity mismatch.')
        if not event.audited:
            event.write({'audited': True})
        return True

    @api.model
    def kemfai_get_pending_selection_event(self):
        event = self.env['kemfai.module.selection.event'].search(
            [('audited', '=', False)], order='created_at asc', limit=1
        )
        return event.kemfai_payload() if event else False


class KemfaiModuleSelectionEvent(models.Model):
    """Same-transaction receipt preserving the truthful delta until audit succeeds."""

    _name = 'kemfai.module.selection.event'
    _description = 'KEMFAI Module Selection Audit Handoff'
    _order = 'created_at asc'

    operation_uuid = fields.Char(required=True, index=True)
    tenant_id = fields.Char(required=True, index=True)
    account_id = fields.Char(required=True, index=True)
    actor_keycloak_user_id = fields.Char(required=True, index=True)
    requested_json = fields.Text(required=True, index=True)
    result_json = fields.Text(required=True)
    added_json = fields.Text(required=True)
    removed_json = fields.Text(required=True)
    created_at = fields.Datetime(required=True, default=fields.Datetime.now)
    occurred_at = fields.Datetime(required=True)
    audited = fields.Boolean(required=True, default=False, index=True)

    _sql_constraints = [
        ('operation_uuid_unique', 'unique(operation_uuid)', 'Operation UUID must be unique.'),
    ]

    def init(self):
        self.env.cr.execute(
            'CREATE UNIQUE INDEX IF NOT EXISTS '
            'kemfai_module_selection_one_pending '
            'ON kemfai_module_selection_event ((audited)) WHERE audited = false'
        )

    def kemfai_payload(self):
        self.ensure_one()
        return {
            'operationUuid': self.operation_uuid,
            'tenantId': self.tenant_id,
            'accountId': self.account_id,
            'actorKeycloakUserId': self.actor_keycloak_user_id,
            'occurredAt': self.occurred_at.replace(tzinfo=timezone.utc).isoformat(
                timespec='milliseconds'
            ).replace('+00:00', 'Z'),
            'featureKeys': json.loads(self.result_json),
            'added': json.loads(self.added_json),
            'removed': json.loads(self.removed_json),
        }
