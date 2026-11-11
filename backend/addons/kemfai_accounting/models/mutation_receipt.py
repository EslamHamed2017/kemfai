import uuid

from odoo import api, fields, models
from odoo.exceptions import ValidationError


class KemfaiAccountMutationReceipt(models.Model):
    _name = "kemfai.account.mutation.receipt"
    _description = "KEMFAI Immutable Account Mutation Receipt"
    _order = "create_date, id"

    operation_uuid = fields.Char(required=True, readonly=True, copy=False, index=True)
    action = fields.Char(required=True, readonly=True, index=True)
    actor_identity = fields.Char(required=True, readonly=True)
    company_id = fields.Many2one(
        "res.company", required=True, readonly=True, ondelete="restrict", index=True
    )
    audit_event_uuid = fields.Char(required=True, readonly=True, index=True)
    result_json = fields.Json(required=True, readonly=True)

    _sql_constraints = [
        (
            "kemfai_account_receipt_operation_unique",
            "unique(operation_uuid)",
            "An accounting operation can have only one immutable receipt.",
        ),
    ]

    @api.model
    def _kemfai_validate_operation_uuid(self, operation_uuid):
        try:
            parsed = uuid.UUID(operation_uuid)
        except (AttributeError, TypeError, ValueError) as error:
            raise ValidationError("INVALID_OPERATION_UUID") from error
        if str(parsed) != operation_uuid.lower():
            raise ValidationError("INVALID_OPERATION_UUID")

    @api.model
    def kemfai_find_result(self, operation_uuid):
        self._kemfai_validate_operation_uuid(operation_uuid)
        # Serialize absent-row retries before any domain mutation. The lock lasts for the
        # current transaction; after the winner commits, the waiter observes its receipt.
        self.env.cr.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            [operation_uuid],
        )
        receipt = self.search([("operation_uuid", "=", operation_uuid)], limit=1)
        return receipt.result_json if receipt else False

    @api.model
    def kemfai_record_result(
        self,
        operation_uuid,
        action,
        actor_identity,
        company_id,
        audit_event_uuid,
        result,
    ):
        self._kemfai_validate_operation_uuid(operation_uuid)
        return self.create(
            {
                "operation_uuid": operation_uuid,
                "action": action,
                "actor_identity": actor_identity,
                "company_id": company_id,
                "audit_event_uuid": audit_event_uuid,
                "result_json": result,
            }
        )

    def write(self, values):
        raise ValidationError("ACCOUNT_MUTATION_RECEIPT_IMMUTABLE")

    def unlink(self):
        if self.env.context.get("module_uninstall"):
            return super().unlink()
        raise ValidationError("ACCOUNT_MUTATION_RECEIPT_IMMUTABLE")
