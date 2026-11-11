import os
import uuid

from odoo import api, fields, models
from odoo.exceptions import ValidationError


class KemfaiAccountAuditEvent(models.Model):
    _name = "kemfai.account.audit.event"
    _description = "KEMFAI Immutable Account Audit Event"
    _order = "create_date, id"

    public_id = fields.Char(
        required=True,
        readonly=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        index=True,
    )
    operation_uuid = fields.Char(required=True, readonly=True, copy=False, index=True)
    company_id = fields.Many2one(
        "res.company", required=True, readonly=True, ondelete="restrict", index=True
    )
    actor_identity = fields.Char(required=True, readonly=True)
    action = fields.Char(required=True, readonly=True, index=True)
    target_model = fields.Char(required=True, readonly=True)
    target_public_id = fields.Char(required=True, readonly=True, index=True)
    before_json = fields.Json(readonly=True)
    after_json = fields.Json(required=True, readonly=True)

    _sql_constraints = [
        (
            "kemfai_account_audit_public_id_unique",
            "unique(public_id)",
            "Audit event public UUID must be unique.",
        ),
        (
            "kemfai_account_audit_operation_unique",
            "unique(operation_uuid)",
            "An accounting operation can emit only one audit event.",
        ),
    ]

    @api.model
    def kemfai_append(
        self,
        operation_uuid,
        action,
        actor_identity,
        company_id,
        resource_model,
        resource_public_id,
        before,
        after,
    ):
        if (
            os.environ.get("KEMFAI_ACCOUNTING_TEST_FAULTS") == "1"
            and self.env["ir.config_parameter"]
            .sudo()
            .get_param("kemfai.accounting.test_fault_mode")
            == "tenant-audit-create-failure"
        ):
            raise ValidationError("ACCOUNT_AUDIT_TEST_FAULT")
        return self.create(
            {
                "operation_uuid": operation_uuid,
                "action": action,
                "actor_identity": actor_identity,
                "company_id": company_id,
                "target_model": resource_model,
                "target_public_id": resource_public_id,
                "before_json": before,
                "after_json": after,
            }
        )

    def write(self, values):
        raise ValidationError("ACCOUNT_AUDIT_EVENT_IMMUTABLE")

    def unlink(self):
        if self.env.context.get("module_uninstall"):
            return super().unlink()
        raise ValidationError("ACCOUNT_AUDIT_EVENT_IMMUTABLE")
