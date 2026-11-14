import uuid

from odoo import api, fields, models
from odoo.exceptions import ValidationError


class KemfaiDimensionValue(models.Model):
    _name = "kemfai.dimension.value"
    _description = "KEMFAI Dimension Value"
    _order = "company_id, definition_id, code, id"
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
    definition_id = fields.Many2one(
        "kemfai.dimension.definition",
        required=True,
        readonly=True,
        ondelete="restrict",
        index=True,
    )
    code = fields.Char(required=True, index=True)
    name_en = fields.Char(string="English Name", required=True)
    name_ar = fields.Char(string="Arabic Name", required=True)
    active = fields.Boolean(required=True, default=True, index=True)
    version = fields.Integer(required=True, readonly=True, copy=False, default=1)
    linked_object_type = fields.Char(readonly=True, copy=False)
    linked_object_id = fields.Char(readonly=True, copy=False)

    _sql_constraints = [
        (
            "kemfai_dimension_value_public_id_unique",
            "unique(public_id)",
            "Dimension value public UUID must be unique.",
        ),
        (
            "kemfai_dimension_value_definition_code_unique",
            "unique(company_id, definition_id, code)",
            "Dimension value code must be unique within its definition.",
        ),
        (
            "kemfai_dimension_value_version_positive",
            "CHECK(version >= 1)",
            "Dimension value version must be positive.",
        ),
    ]

    @api.model_create_multi
    def create(self, values_list):
        for values in values_list:
            definition = self.env["kemfai.dimension.definition"].browse(
                values.get("definition_id")
            ).exists()
            if not definition:
                raise ValidationError("DIMENSION_DEFINITION_NOT_FOUND")
            if definition.company_id.id != values.get("company_id"):
                raise ValidationError("DIMENSION_VALUE_COMPANY_MISMATCH")
            if not definition.active:
                raise ValidationError("DIMENSION_DEFINITION_INACTIVE")
            if self.search_count(
                [
                    ("company_id", "=", values.get("company_id")),
                    ("definition_id", "=", values.get("definition_id")),
                    ("code", "=", values.get("code")),
                ],
                limit=1,
            ):
                raise ValidationError("DIMENSION_VALUE_CODE_EXISTS")
        return super().create(values_list)

    @api.constrains("company_id", "definition_id")
    def _check_definition_company(self):
        for value in self:
            if value.definition_id.company_id != value.company_id:
                raise ValidationError("DIMENSION_VALUE_COMPANY_MISMATCH")

    def write(self, values):
        immutable_fields = {
            "public_id": "DIMENSION_VALUE_PUBLIC_UUID_IMMUTABLE",
            "company_id": "DIMENSION_VALUE_COMPANY_IMMUTABLE",
            "definition_id": "DIMENSION_VALUE_DEFINITION_IMMUTABLE",
            "linked_object_type": "DIMENSION_VALUE_LINK_IMMUTABLE",
            "linked_object_id": "DIMENSION_VALUE_LINK_IMMUTABLE",
        }
        relational_fields = {"company_id", "definition_id"}
        for value in self:
            for field_name, error_code in immutable_fields.items():
                if field_name not in values:
                    continue
                current_value = (
                    value[field_name].id
                    if field_name in relational_fields
                    else value[field_name]
                )
                if values[field_name] != current_value:
                    raise ValidationError(error_code)

        for value in self:
            record_values = dict(values)
            record_values["version"] = value.version + 1
            super(KemfaiDimensionValue, value).write(record_values)
        return True

    def unlink(self):
        if self.env.context.get("module_uninstall"):
            return super().unlink()
        raise ValidationError("HISTORY_PROTECTED")
