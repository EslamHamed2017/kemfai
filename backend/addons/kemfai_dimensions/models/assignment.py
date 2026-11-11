import uuid

from odoo import api, fields, models
from odoo.exceptions import ValidationError


class KemfaiAccountDraftDimension(models.Model):
    _name = "kemfai.account.draft.dimension"
    _description = "KEMFAI Draft Line Dimension Assignment"
    _order = "draft_line_id, definition_id, id"

    public_id = fields.Char(
        required=True,
        readonly=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        index=True,
    )
    draft_line_id = fields.Many2one(
        "kemfai.account.draft.line",
        required=True,
        readonly=True,
        ondelete="cascade",
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
    value_id = fields.Many2one(
        "kemfai.dimension.value",
        required=True,
        readonly=True,
        ondelete="restrict",
        index=True,
    )
    definition_name_en = fields.Char(required=True, readonly=True)
    definition_name_ar = fields.Char(required=True, readonly=True)
    value_name_en = fields.Char(required=True, readonly=True)
    value_name_ar = fields.Char(required=True, readonly=True)

    _sql_constraints = [
        (
            "kemfai_draft_dimension_public_id_unique",
            "unique(public_id)",
            "Draft dimension assignment public UUID must be unique.",
        ),
        (
            "kemfai_draft_dimension_line_definition_unique",
            "unique(draft_line_id, definition_id)",
            "DIMENSION_ASSIGNMENT_CATEGORY_DUPLICATE",
        ),
    ]

    @api.model_create_multi
    def create(self, values_list):
        prepared_values = []
        for values in values_list:
            prepared_values.append(self._prepare_assignment_values(values))
        return super().create(prepared_values)

    @api.model
    def _prepare_assignment_values(self, values):
        line = self.env["kemfai.account.draft.line"].browse(
            values.get("draft_line_id")
        ).exists()
        if not line:
            raise ValidationError("DRAFT_LINE_NOT_FOUND")

        definition = self.env["kemfai.dimension.definition"].browse(
            values.get("definition_id")
        ).exists()
        value = self.env["kemfai.dimension.value"].browse(
            values.get("value_id")
        ).exists()
        if not definition or not value:
            raise ValidationError("DIMENSION_ASSIGNMENT_NOT_FOUND")
        if (
            definition.company_id != line.company_id
            or value.company_id != line.company_id
            or value.definition_id != definition
        ):
            raise ValidationError("DIMENSION_ASSIGNMENT_OUT_OF_SCOPE")
        if not definition.active or not value.active:
            raise ValidationError("DIMENSION_ASSIGNMENT_INACTIVE")

        duplicate = self.search_count(
            [
                ("draft_line_id", "=", line.id),
                ("definition_id", "=", definition.id),
            ],
            limit=1,
        )
        if duplicate:
            raise ValidationError("DIMENSION_ASSIGNMENT_CATEGORY_DUPLICATE")

        prepared = dict(values)
        prepared.update(
            {
                "company_id": line.company_id.id,
                "definition_name_en": definition.name_en,
                "definition_name_ar": definition.name_ar,
                "value_name_en": value.name_en,
                "value_name_ar": value.name_ar,
            }
        )
        return prepared

    def write(self, values):
        immutable_fields = {
            "public_id",
            "draft_line_id",
            "company_id",
            "definition_id",
            "value_id",
            "definition_name_en",
            "definition_name_ar",
            "value_name_en",
            "value_name_ar",
        }
        if immutable_fields.intersection(values):
            raise ValidationError("DIMENSION_ASSIGNMENT_IMMUTABLE")
        return super().write(values)
