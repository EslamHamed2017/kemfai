import uuid

from odoo import api, fields, models
from odoo.exceptions import ValidationError


class KemfaiDimensionDefinition(models.Model):
    _name = "kemfai.dimension.definition"
    _description = "KEMFAI Dimension Definition"
    _order = "company_id, key, id"
    _rec_name = "name_en"

    public_id = fields.Char(
        required=True,
        readonly=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        index=True,
    )
    company_id = fields.Many2one(
        "res.company",
        required=True,
        readonly=True,
        ondelete="restrict",
        index=True,
    )
    key = fields.Char(required=True, index=True)
    kind = fields.Selection(
        selection=[
            ("built_in", "Built-in"),
            ("custom", "Custom"),
            ("tag", "Tag"),
        ],
        required=True,
        default="custom",
        index=True,
    )
    name_en = fields.Char(string="English Name", required=True)
    name_ar = fields.Char(string="Arabic Name", required=True)
    active = fields.Boolean(required=True, default=True, index=True)
    version = fields.Integer(required=True, readonly=True, copy=False, default=1)

    _sql_constraints = [
        (
            "kemfai_dimension_definition_public_id_unique",
            "unique(public_id)",
            "Dimension definition public UUID must be unique.",
        ),
        (
            "kemfai_dimension_definition_company_key_unique",
            "unique(company_id, key)",
            "Dimension definition key must be unique within a company.",
        ),
        (
            "kemfai_dimension_definition_version_positive",
            "CHECK(version >= 1)",
            "Dimension definition version must be positive.",
        ),
    ]

    @api.model_create_multi
    def create(self, values_list):
        for values in values_list:
            if self.search_count(
                [
                    ("company_id", "=", values.get("company_id")),
                    ("key", "=", values.get("key")),
                ],
                limit=1,
            ):
                raise ValidationError("DIMENSION_DEFINITION_KEY_EXISTS")
        return super().create(values_list)

    def write(self, values):
        for definition in self:
            if "public_id" in values and values["public_id"] != definition.public_id:
                raise ValidationError("DIMENSION_DEFINITION_PUBLIC_UUID_IMMUTABLE")
            if "company_id" in values and values["company_id"] != definition.company_id.id:
                raise ValidationError("DIMENSION_DEFINITION_COMPANY_IMMUTABLE")
            if definition.kind == "built_in":
                if "key" in values and values["key"] != definition.key:
                    raise ValidationError("BUILT_IN_DIMENSION_KEY_IMMUTABLE")
                if "kind" in values and values["kind"] != definition.kind:
                    raise ValidationError("BUILT_IN_DIMENSION_KIND_IMMUTABLE")

        for definition in self:
            record_values = dict(values)
            record_values["version"] = definition.version + 1
            super(KemfaiDimensionDefinition, definition).write(record_values)
        return True

    def unlink(self):
        if self.env.context.get("module_uninstall"):
            return super().unlink()
        raise ValidationError("HISTORY_PROTECTED")
