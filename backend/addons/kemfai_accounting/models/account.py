import uuid

from odoo import api, fields, models
from odoo.exceptions import ValidationError


class ResCompany(models.Model):
    _inherit = "res.company"

    kemfai_public_id = fields.Char(
        string="KEMFAI Public UUID",
        required=True,
        readonly=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        index=True,
    )

    _sql_constraints = [
        (
            "kemfai_company_public_id_unique",
            "unique(kemfai_public_id)",
            "KEMFAI company public UUID must be unique.",
        ),
    ]

    def write(self, values):
        if "kemfai_public_id" in values:
            for company in self:
                if company.kemfai_public_id and values["kemfai_public_id"] != company.kemfai_public_id:
                    raise ValidationError("COMPANY_PUBLIC_UUID_IMMUTABLE")
        return super().write(values)


class AccountAccount(models.Model):
    _inherit = "account.account"

    company_id = fields.Many2one(
        "res.company",
        required=True,
        default=lambda self: self.env.company,
        ondelete="restrict",
        index=True,
    )
    active = fields.Boolean(required=True, default=True, index=True)

    kemfai_public_id = fields.Char(
        string="KEMFAI Public UUID",
        required=True,
        readonly=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        index=True,
    )
    name_en = fields.Char(string="English Name", required=True, default="Unnamed")
    name_ar = fields.Char(string="Arabic Name", required=True, default="غير مسمى")
    kemfai_node_kind = fields.Selection(
        selection=[("parent", "Parent"), ("posting", "Posting")],
        string="KEMFAI Node Kind",
        required=True,
        default="posting",
        index=True,
    )
    kemfai_parent_id = fields.Many2one(
        comodel_name="account.account",
        string="KEMFAI Parent Account",
        ondelete="restrict",
        index=True,
        domain="[('company_id', '=', company_id), ('kemfai_node_kind', '=', 'parent'), ('active', '=', True)]",
    )
    version = fields.Integer(required=True, readonly=True, copy=False, default=1)

    _sql_constraints = [
        (
            "kemfai_account_public_id_unique",
            "unique(kemfai_public_id)",
            "KEMFAI account public UUID must be unique.",
        ),
        (
            "kemfai_account_version_positive",
            "CHECK(version >= 1)",
            "Account version must be positive.",
        ),
    ]

    @api.model_create_multi
    def create(self, values_list):
        normalized = []
        for values in values_list:
            values = dict(values)
            company_id = values.get("company_id") or self.env.company.id
            values["company_id"] = company_id
            values["company_ids"] = [(6, 0, [company_id])]
            normalized.append(values)
        return super().create(normalized)

    @api.model
    def kemfai_posting_selection_domain(self, company_id):
        return [
            ("company_id", "=", company_id),
            ("kemfai_node_kind", "=", "posting"),
            ("active", "=", True),
        ]

    @api.constrains("kemfai_parent_id", "company_id", "kemfai_node_kind")
    def _check_kemfai_hierarchy(self):
        for account in self:
            parent = account.kemfai_parent_id
            if not parent:
                continue
            if parent.company_id != account.company_id:
                raise ValidationError("ACCOUNT_PARENT_COMPANY_MISMATCH")
            if parent.kemfai_node_kind != "parent":
                raise ValidationError("ACCOUNT_PARENT_NOT_PARENT_NODE")
            visited = {account.id}
            cursor = parent
            while cursor:
                if cursor.id in visited:
                    raise ValidationError("ACCOUNT_HIERARCHY_CYCLE")
                visited.add(cursor.id)
                cursor = cursor.kemfai_parent_id

    def write(self, values):
        if "kemfai_public_id" in values:
            raise ValidationError("ACCOUNT_PUBLIC_UUID_IMMUTABLE")
        if "company_id" in values:
            for account in self:
                if account.company_id.id != values["company_id"]:
                    raise ValidationError("ACCOUNT_COMPANY_IMMUTABLE")
        if "company_ids" in values and self.filtered("kemfai_public_id"):
            raise ValidationError("ACCOUNT_COMPANY_IMMUTABLE")
        return super().write(values)
