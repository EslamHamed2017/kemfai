import uuid
from datetime import date

from odoo import api, fields, models
from odoo.exceptions import ValidationError


class KemfaiDimensionRule(models.Model):
    _name = "kemfai.dimension.rule"
    _description = "KEMFAI Dimension Rule"
    _order = "company_id, dimension_definition_id, id"

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
    account_id = fields.Many2one(
        "account.account",
        ondelete="restrict",
        index=True,
    )
    transaction_type_key = fields.Char(index=True)
    dimension_definition_id = fields.Many2one(
        "kemfai.dimension.definition",
        required=True,
        readonly=True,
        ondelete="restrict",
        index=True,
    )
    requirement = fields.Selection(
        selection=[
            ("required", "Required"),
            ("optional", "Optional"),
            ("prohibited", "Prohibited"),
        ],
        required=True,
        index=True,
    )
    effective_from = fields.Date(required=True, index=True)
    effective_to = fields.Date(index=True)
    active = fields.Boolean(required=True, default=True, index=True)
    version = fields.Integer(required=True, readonly=True, copy=False, default=1)

    _sql_constraints = [
        (
            "kemfai_dimension_rule_public_id_unique",
            "unique(public_id)",
            "Dimension rule public UUID must be unique.",
        ),
        (
            "kemfai_dimension_rule_version_positive",
            "CHECK(version >= 1)",
            "Dimension rule version must be positive.",
        ),
        (
            "kemfai_dimension_rule_effective_range",
            "CHECK(effective_to IS NULL OR effective_to >= effective_from)",
            "DIMENSION_RULE_INVALID_EFFECTIVE_RANGE",
        ),
        (
            "kemfai_dimension_rule_has_scope",
            "CHECK(account_id IS NOT NULL OR transaction_type_key IS NOT NULL)",
            "DIMENSION_RULE_SCOPE_REQUIRED",
        ),
    ]

    @api.model_create_multi
    def create(self, values_list):
        for values in values_list:
            self._validate_scope_values(values)
            self._check_candidate_overlap(values)
        return super().create(values_list)

    def write(self, values):
        immutable_fields = {
            "public_id": "DIMENSION_RULE_PUBLIC_UUID_IMMUTABLE",
            "company_id": "DIMENSION_RULE_COMPANY_IMMUTABLE",
            "dimension_definition_id": "DIMENSION_RULE_DEFINITION_IMMUTABLE",
        }
        relational_fields = {"company_id", "dimension_definition_id"}
        for rule in self:
            for field_name, error_code in immutable_fields.items():
                if field_name not in values:
                    continue
                current_value = (
                    rule[field_name].id
                    if field_name in relational_fields
                    else rule[field_name]
                )
                if values[field_name] != current_value:
                    raise ValidationError(error_code)
            candidate = {
                "company_id": rule.company_id.id,
                "dimension_definition_id": rule.dimension_definition_id.id,
                "account_id": rule.account_id.id or False,
                "transaction_type_key": rule.transaction_type_key or False,
            }
            candidate.update(values)
            candidate.update(
                {
                    "requirement": values.get("requirement", rule.requirement),
                    "effective_from": values.get(
                        "effective_from", rule.effective_from
                    ),
                    "effective_to": values.get("effective_to", rule.effective_to),
                    "active": values.get("active", rule.active),
                }
            )
            self._validate_scope_values(candidate)
            self._check_candidate_overlap(candidate, exclude_id=rule.id)

        for rule in self:
            record_values = dict(values)
            record_values["version"] = rule.version + 1
            super(KemfaiDimensionRule, rule).write(record_values)
        return True

    @api.model
    def _validate_scope_values(self, values):
        account_id = values.get("account_id") or False
        transaction_type_key = values.get("transaction_type_key") or False
        if not account_id and not transaction_type_key:
            raise ValidationError("DIMENSION_RULE_SCOPE_REQUIRED")

        definition = self.env["kemfai.dimension.definition"].browse(
            values.get("dimension_definition_id")
        ).exists()
        if not definition:
            raise ValidationError("DIMENSION_DEFINITION_NOT_FOUND")
        company_id = values.get("company_id")
        if definition.company_id.id != company_id:
            raise ValidationError("DIMENSION_RULE_COMPANY_MISMATCH")
        if not definition.active:
            raise ValidationError("DIMENSION_DEFINITION_INACTIVE")

        if account_id:
            account = self.env["account.account"].browse(account_id).exists()
            if not account:
                raise ValidationError("DIMENSION_RULE_ACCOUNT_NOT_FOUND")
            account_company_ids = account.company_ids.ids
            if company_id not in account_company_ids:
                raise ValidationError("DIMENSION_RULE_COMPANY_MISMATCH")

    @api.constrains(
        "company_id",
        "account_id",
        "transaction_type_key",
        "dimension_definition_id",
        "requirement",
        "effective_from",
        "effective_to",
        "active",
    )
    def _check_rule_constraints(self):
        for rule in self:
            self._validate_scope_values(
                {
                    "company_id": rule.company_id.id,
                    "account_id": rule.account_id.id or False,
                    "transaction_type_key": rule.transaction_type_key or False,
                    "dimension_definition_id": rule.dimension_definition_id.id,
                }
            )
            if rule.effective_to and rule.effective_to < rule.effective_from:
                raise ValidationError("DIMENSION_RULE_INVALID_EFFECTIVE_RANGE")

    @api.model
    def _check_candidate_overlap(self, values, exclude_id=None):
        if not values.get("active", True):
            return
        effective_from = fields.Date.to_date(values.get("effective_from"))
        effective_to = fields.Date.to_date(values.get("effective_to"))
        domain = [
            ("active", "=", True),
            ("company_id", "=", values.get("company_id")),
            (
                "dimension_definition_id",
                "=",
                values.get("dimension_definition_id"),
            ),
            ("account_id", "=", values.get("account_id") or False),
            (
                "transaction_type_key",
                "=",
                values.get("transaction_type_key") or False,
            ),
            "|",
            ("effective_to", "=", False),
            ("effective_to", ">=", effective_from),
        ]
        if exclude_id:
            domain.insert(0, ("id", "!=", exclude_id))
        if effective_to:
            domain.append(("effective_from", "<=", effective_to))
        overlapping = self.search(domain, limit=1)
        if overlapping:
            error_code = (
                "DIMENSION_RULE_CONFLICT"
                if overlapping.requirement != values.get("requirement")
                else "DIMENSION_RULE_OVERLAP"
            )
            raise ValidationError(error_code)

    @api.model
    def kemfai_resolve_rules(
        self,
        *,
        company_id,
        account_id=None,
        transaction_type_key=None,
        effective_on=None,
    ):
        effective_on = fields.Date.to_date(effective_on or date.today())
        domain = [
            ("company_id", "=", company_id),
            ("active", "=", True),
            ("dimension_definition_id.active", "=", True),
            ("effective_from", "<=", effective_on),
            "|",
            ("effective_to", "=", False),
            ("effective_to", ">=", effective_on),
        ]
        scope_domain = []
        if account_id:
            scope_domain.append(("account_id", "=", account_id))
        if transaction_type_key:
            scope_domain.append(("transaction_type_key", "=", transaction_type_key))
        if not scope_domain:
            return []
        domain += (["|"] if len(scope_domain) == 2 else []) + scope_domain

        grouped = {}
        for rule in self.search(domain, order="id"):
            if rule.account_id and rule.account_id.id != account_id:
                continue
            if (
                rule.transaction_type_key
                and rule.transaction_type_key != transaction_type_key
            ):
                continue
            specificity = int(bool(rule.account_id)) + int(
                bool(rule.transaction_type_key)
            )
            grouped.setdefault(rule.dimension_definition_id.id, []).append(
                (specificity, rule)
            )

        resolved = []
        for definition_id in sorted(grouped):
            candidates = grouped[definition_id]
            best_specificity = max(item[0] for item in candidates)
            best = [rule for specificity, rule in candidates if specificity == best_specificity]
            requirements = {rule.requirement for rule in best}
            if len(requirements) != 1:
                raise ValidationError("DIMENSION_RULE_CONFLICT")
            rule = min(best, key=lambda item: item.id)
            resolved.append(
                {
                    "rule_id": rule.public_id,
                    "rule_version": rule.version,
                    "dimension_definition_id": rule.dimension_definition_id.public_id,
                    "dimension_definition_version": rule.dimension_definition_id.version,
                    "requirement": rule.requirement,
                }
            )
        return resolved

    @api.model
    def kemfai_update_rule(self, public_id, expected_version, values):
        self.env.cr.execute(
            """
            SELECT id, version
              FROM kemfai_dimension_rule
             WHERE public_id = %s
             FOR UPDATE
            """,
            [public_id],
        )
        row = self.env.cr.fetchone()
        if not row:
            raise ValidationError("DIMENSION_RULE_NOT_FOUND")
        rule_id, current_version = row
        if current_version != expected_version:
            raise ValidationError("STALE_VERSION")

        allowed_fields = {
            "account_id",
            "transaction_type_key",
            "requirement",
            "effective_from",
            "effective_to",
            "active",
        }
        if set(values) - allowed_fields:
            raise ValidationError("DIMENSION_RULE_FIELD_NOT_MUTABLE")
        rule = self.browse(rule_id)
        rule.write(values)
        return {
            "public_id": rule.public_id,
            "version": rule.version,
            "requirement": rule.requirement,
        }

    def unlink(self):
        if self.env.context.get("module_uninstall"):
            return super().unlink()
        raise ValidationError("HISTORY_PROTECTED")
