import copy
from decimal import Decimal, InvalidOperation
import re
import uuid

from odoo import api, fields, models
from odoo.exceptions import AccessError, ValidationError

from .coa import operation_race_retry


DECIMAL_LEXEME = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$")


class KemfaiAccountDraftValidationRun(models.Model):
    _name = "kemfai.account.draft.validation"
    _description = "KEMFAI Immutable Draft Validation Run"
    _order = "create_date, id"

    public_id = fields.Char(
        required=True,
        readonly=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        index=True,
    )
    draft_id = fields.Many2one(
        "kemfai.account.draft",
        required=True,
        readonly=True,
        ondelete="restrict",
        index=True,
    )
    draft_version = fields.Integer(required=True, readonly=True)
    status = fields.Selection(
        [("valid_for_draft", "Valid for Draft"), ("invalid", "Invalid")],
        required=True,
        readonly=True,
    )
    checks_performed = fields.Json(readonly=True)
    errors = fields.Json(readonly=True)
    warnings = fields.Json(readonly=True)
    policy_blockers = fields.Json(readonly=True)
    base_debit_total = fields.Char(required=True, readonly=True)
    base_credit_total = fields.Char(required=True, readonly=True)
    company_base_currency_code = fields.Char(required=True, readonly=True)
    base_precision = fields.Integer(required=True, readonly=True)
    ledger_effect = fields.Selection(
        [("none", "None")], required=True, readonly=True, default="none"
    )
    rule_versions = fields.Json(readonly=True)
    configuration_versions = fields.Json(readonly=True)
    validated_by = fields.Char(required=True, readonly=True)
    validated_at = fields.Datetime(
        required=True, readonly=True, default=fields.Datetime.now
    )

    _sql_constraints = [
        (
            "kemfai_draft_validation_public_id_unique",
            "unique(public_id)",
            "Draft validation public UUID must be unique.",
        )
    ]

    def write(self, values):
        raise ValidationError("DRAFT_VALIDATION_IMMUTABLE")

    def unlink(self):
        if self.env.context.get("module_uninstall"):
            return super().unlink()
        raise ValidationError("DRAFT_VALIDATION_IMMUTABLE")


class KemfaiAccountDraftValidation(models.Model):
    _inherit = "kemfai.account.draft"

    @api.model
    def _kemfai_company(self, company_id):
        company = self.env["res.company"].browse(company_id).exists()
        if not company or company not in self.env.user.company_ids:
            raise AccessError("ACCOUNT_SCOPE_DENIED")
        return company

    @api.model
    def _kemfai_uuid(self, value, code):
        try:
            parsed = uuid.UUID(value)
        except (AttributeError, TypeError, ValueError) as error:
            raise ValidationError(code) from error
        if str(parsed) != value.lower():
            raise ValidationError(code)
        return value

    @api.model
    def _kemfai_payload(self, values):
        if not isinstance(values, dict):
            raise ValidationError("DRAFT_PAYLOAD_INVALID")
        required = {
            "journalId",
            "accountingDate",
            "description",
            "transactionType",
            "lines",
        }
        if required - set(values) or values.get("transactionType") != "manual_journal":
            raise ValidationError("DRAFT_PAYLOAD_INVALID")
        self._kemfai_uuid(values.get("journalId"), "DRAFT_JOURNAL_ID_INVALID")
        lines = values.get("lines")
        if not isinstance(lines, list) or not lines:
            raise ValidationError("DRAFT_LINES_INVALID")
        for line in lines:
            if not isinstance(line, dict):
                raise ValidationError("DRAFT_LINES_INVALID")
            self._kemfai_uuid(line.get("id"), "DRAFT_LINE_ID_INVALID")
            self._kemfai_uuid(line.get("accountId"), "DRAFT_ACCOUNT_ID_INVALID")
            for amount in (
                "transactionDebit",
                "transactionCredit",
                "baseDebit",
                "baseCredit",
            ):
                if not isinstance(line.get(amount), str):
                    raise ValidationError("DRAFT_DECIMAL_INVALID")
            dimensions = line.get("dimensions")
            if not isinstance(dimensions, list):
                raise ValidationError("DRAFT_DIMENSIONS_INVALID")
            for assignment in dimensions:
                if not isinstance(assignment, dict) or set(assignment) != {
                    "definitionId",
                    "valueId",
                }:
                    raise ValidationError("DRAFT_DIMENSIONS_INVALID")
                self._kemfai_uuid(
                    assignment.get("definitionId"),
                    "DRAFT_DIMENSION_DEFINITION_ID_INVALID",
                )
                self._kemfai_uuid(
                    assignment.get("valueId"), "DRAFT_DIMENSION_VALUE_ID_INVALID"
                )
        # A defensive copy prevents caller-side mutation and preserves decimal lexemes.
        return copy.deepcopy(values)

    @api.model
    def _kemfai_account(self, account_public_id):
        return self.env["account.account"].with_context(active_test=False).search(
            [("kemfai_public_id", "=", account_public_id)], limit=1
        )

    @api.model
    def _kemfai_eligible_account(self, company, account_public_id):
        account = self._kemfai_account(account_public_id)
        if not account:
            raise ValidationError("ACCOUNT_NOT_FOUND")
        if account.company_id != company:
            raise ValidationError("ACCOUNT_COMPANY_MISMATCH")
        if not account.active:
            raise ValidationError("ACCOUNT_INACTIVE")
        if account.kemfai_node_kind != "posting":
            raise ValidationError("ACCOUNT_NOT_POSTING")
        return account

    @api.model
    def _kemfai_draft_for_update(self, public_id, company_id):
        self.env.cr.execute(
            """
            SELECT id FROM kemfai_account_draft
             WHERE public_id = %s AND company_id = %s
             FOR UPDATE
            """,
            [public_id, company_id],
        )
        row = self.env.cr.fetchone()
        if not row:
            raise ValidationError("DRAFT_NOT_FOUND")
        return self.browse(row[0]).exists()

    @api.model
    def _kemfai_dimension_records(self, assignment):
        definition = self.env["kemfai.dimension.definition"].with_context(
            active_test=False
        ).search([("public_id", "=", assignment["definitionId"])], limit=1)
        value = self.env["kemfai.dimension.value"].with_context(
            active_test=False
        ).search([("public_id", "=", assignment["valueId"])], limit=1)
        return definition, value

    @api.model
    def _kemfai_dimension_result(self, assignment, company):
        definition, value = self._kemfai_dimension_records(assignment)
        in_scope = bool(
            definition
            and value
            and definition.company_id == company
            and value.company_id == company
            and value.definition_id == definition
        )
        result = {
            "definition_id": assignment["definitionId"],
            "value_id": assignment["valueId"],
            "active": bool(in_scope and definition.active and value.active),
        }
        if in_scope:
            result.update(
                {
                    "definition_name_en": definition.name_en,
                    "definition_name_ar": definition.name_ar,
                    "value_name_en": value.name_en,
                    "value_name_ar": value.name_ar,
                    "definition_version": definition.version,
                    "value_version": value.version,
                }
            )
        return result

    @api.model
    def _kemfai_dimension_issue(self, code, line, resource_id):
        return {
            "code": code,
            "message_key": code,
            "line_id": line["id"],
            "resource_id": resource_id,
            "field": "dimensions",
        }

    @api.model
    def _kemfai_validate_line_dimensions(self, draft, line, account):
        assignments = {}
        issues = []
        for assignment in line.get("dimensions", []):
            definition, value = self._kemfai_dimension_records(assignment)
            if not (
                definition
                and value
                and definition.company_id == draft.company_id
                and value.company_id == draft.company_id
                and value.definition_id == definition
            ):
                issues.append(
                    self._kemfai_dimension_issue(
                        "DIMENSION_OUT_OF_SCOPE", line, assignment["valueId"]
                    )
                )
                continue
            assignments[definition.public_id] = (assignment, definition, value)
            if not definition.active or not value.active:
                issues.append(
                    self._kemfai_dimension_issue(
                        "DIMENSION_INACTIVE", line, value.public_id
                    )
                )

        rules = self.env["kemfai.dimension.rule"].kemfai_resolve_rules(
            company_id=draft.company_id.id,
            account_id=account.id if account else None,
            transaction_type_key=draft.payload_json["transactionType"],
            effective_on=draft.payload_json["accountingDate"],
        )
        for rule in rules:
            assignment = assignments.get(rule["dimension_definition_id"])
            if rule["requirement"] == "required" and not assignment:
                issues.append(
                    self._kemfai_dimension_issue(
                        "DIMENSION_REQUIRED",
                        line,
                        rule["dimension_definition_id"],
                    )
                )
            elif rule["requirement"] == "prohibited" and assignment:
                issues.append(
                    self._kemfai_dimension_issue(
                        "DIMENSION_PROHIBITED", line, assignment[2].public_id
                    )
                )
        return issues, rules

    @api.model
    def _kemfai_line_result(self, line, company):
        account = self._kemfai_account(line["accountId"])
        return {
            "id": line["id"],
            "sequence": line["sequence"],
            "account_id": line["accountId"],
            "account_code": account.code if account else "",
            "account_name_en": account.name_en if account else "",
            "account_name_ar": account.name_ar if account else "",
            **(
                {"description": line["description"]}
                if "description" in line
                else {}
            ),
            "transaction_currency_code": line["transactionCurrencyCode"],
            "transaction_precision": line["transactionPrecision"],
            "transaction_currency_metadata_version": line[
                "transactionCurrencyMetadataVersion"
            ],
            "company_base_currency_code": line["companyBaseCurrencyCode"],
            "base_precision": line["basePrecision"],
            "base_currency_metadata_version": line["baseCurrencyMetadataVersion"],
            "currency_configuration_version": line["currencyConfigurationVersion"],
            "transaction_debit": line["transactionDebit"],
            "transaction_credit": line["transactionCredit"],
            "base_debit": line["baseDebit"],
            "base_credit": line["baseCredit"],
            "rate_reference": line["rateReference"],
            "rate_effective_date": line["rateEffectiveDate"],
            "dimensions": [
                self._kemfai_dimension_result(assignment, company)
                for assignment in line.get("dimensions", [])
            ],
        }

    @api.model
    def _kemfai_issue(self, code, *, line=None, field=None, resource_id=None):
        issue = {"code": code, "message_key": code}
        if line is not None:
            issue["line_id"] = line["id"]
        if field is not None:
            issue["field"] = field
        if resource_id is not None:
            issue["resource_id"] = resource_id
        return issue

    @api.model
    def _kemfai_decimal(self, lexeme):
        if not isinstance(lexeme, str) or not DECIMAL_LEXEME.fullmatch(lexeme):
            return None
        try:
            return Decimal(lexeme)
        except InvalidOperation:
            return None

    @api.model
    def _kemfai_decimal_scale(self, lexeme):
        # Preserve the submitted lexeme separately, but trailing zeroes do not
        # require a rounding decision and therefore are not a policy blocker.
        return len(lexeme.partition(".")[2].rstrip("0")) if "." in lexeme else 0

    @api.model
    def _kemfai_money_validation(self, draft):
        payload = draft.payload_json
        lines = payload["lines"]
        errors = []
        policy_blockers = []
        checks = [
            "exact_decimal_lexemes",
            "debit_credit_exclusivity",
            "base_arithmetic",
            "journal_activity_and_version",
            "currency_activity_and_versions",
            "conditional_fx_provenance",
        ]
        configuration_versions = []
        seen_configurations = set()
        seen_accounts = set()
        base_debit_total = Decimal(0)
        base_credit_total = Decimal(0)
        base_scale = max(
            (
                len(line[field].partition(".")[2]) if "." in line[field] else 0
                for line in lines
                for field in ("baseDebit", "baseCredit")
                if isinstance(line.get(field), str)
            ),
            default=0,
        )

        journal = self.env["account.journal"].with_context(active_test=False).search(
            [
                ("kemfai_public_id", "=", payload["journalId"]),
                ("company_id", "=", draft.company_id.id),
            ],
            limit=1,
        )
        if not journal:
            errors.append(
                self._kemfai_issue(
                    "JOURNAL_OUT_OF_SCOPE",
                    field="journalId",
                    resource_id=payload["journalId"],
                )
            )
        else:
            journal_snapshot = next(
                (
                    line.journal_version
                    for line in draft.line_ids
                    if line.journal_version
                ),
                journal.version,
            )
            configuration_versions.append(
                {
                    "kind": "journal",
                    "resource_id": journal.kemfai_public_id,
                    "snapshot_version": journal_snapshot,
                    "current_version": journal.version,
                }
            )
            if not journal.active:
                errors.append(
                    self._kemfai_issue(
                        "JOURNAL_INACTIVE",
                        field="journalId",
                        resource_id=payload["journalId"],
                    )
                )
            if journal.version != journal_snapshot:
                errors.append(
                    self._kemfai_issue(
                        "JOURNAL_STALE",
                        field="journalId",
                        resource_id=payload["journalId"],
                    )
                )

        for line in lines:
            persisted_line = draft.line_ids.filtered(
                lambda candidate: candidate.public_id == line["id"]
            )[:1]
            account = self._kemfai_account(line["accountId"])
            if account and account.kemfai_public_id not in seen_accounts:
                seen_accounts.add(account.kemfai_public_id)
                account_snapshot = (
                    persisted_line.account_version
                    if persisted_line and persisted_line.account_version
                    else account.version
                )
                configuration_versions.append(
                    {
                        "kind": "account",
                        "resource_id": account.kemfai_public_id,
                        "snapshot_version": account_snapshot,
                        "current_version": account.version,
                    }
                )
                if account.version != account_snapshot:
                    errors.append(
                        self._kemfai_issue(
                            "ACCOUNT_STALE",
                            line=line,
                            field="account_id",
                            resource_id=account.kemfai_public_id,
                        )
                    )

            amounts = {}
            for field, result_field in (
                ("transactionDebit", "transaction_debit"),
                ("transactionCredit", "transaction_credit"),
                ("baseDebit", "base_debit"),
                ("baseCredit", "base_credit"),
            ):
                value = self._kemfai_decimal(line.get(field))
                amounts[field] = value
                if value is None:
                    errors.append(
                        self._kemfai_issue(
                            "DRAFT_DECIMAL_INVALID", line=line, field=result_field
                        )
                    )

            if amounts["baseDebit"] is not None:
                base_debit_total += amounts["baseDebit"]
            if amounts["baseCredit"] is not None:
                base_credit_total += amounts["baseCredit"]
            for debit, credit, field in (
                ("transactionDebit", "transactionCredit", "transaction_amount"),
                ("baseDebit", "baseCredit", "base_amount"),
            ):
                if (
                    amounts[debit] is not None
                    and amounts[credit] is not None
                    and amounts[debit] > 0
                    and amounts[credit] > 0
                ):
                    errors.append(
                        self._kemfai_issue(
                            "DEBIT_CREDIT_EXCLUSIVE", line=line, field=field
                        )
                    )

            for field, precision_field, result_field in (
                ("transactionDebit", "transactionPrecision", "transaction_debit"),
                ("transactionCredit", "transactionPrecision", "transaction_credit"),
                ("baseDebit", "basePrecision", "base_debit"),
                ("baseCredit", "basePrecision", "base_credit"),
            ):
                value = line.get(field)
                precision = line.get(precision_field)
                if (
                    isinstance(value, str)
                    and isinstance(precision, int)
                    and not isinstance(precision, bool)
                    and self._kemfai_decimal_scale(value) > precision
                ):
                    policy_blockers.append(
                        self._kemfai_issue(
                            "AMOUNT_SCALE_EXCEEDS_METADATA",
                            line=line,
                            field=result_field,
                        )
                    )

            configuration = self.env[
                "kemfai.account.currency.config"
            ].with_context(active_test=False).search(
                [
                    ("company_id", "=", draft.company_id.id),
                    ("currency_code", "=", line["transactionCurrencyCode"]),
                ],
                limit=1,
            )
            if not configuration:
                errors.append(
                    self._kemfai_issue(
                        "CURRENCY_CONFIGURATION_OUT_OF_SCOPE",
                        line=line,
                        field="transaction_currency_code",
                    )
                )
            else:
                if configuration.public_id not in seen_configurations:
                    seen_configurations.add(configuration.public_id)
                    configuration_versions.append(
                        {
                            "kind": "currency",
                            "configuration_id": configuration.public_id,
                            "configuration_version": line[
                                "currencyConfigurationVersion"
                            ],
                            "current_configuration_version": configuration.version,
                            "currency_code": line["transactionCurrencyCode"],
                            "native_metadata_version": line[
                                "transactionCurrencyMetadataVersion"
                            ],
                            "native_decimal_places": line["transactionPrecision"],
                        }
                    )
                if not configuration.enabled:
                    errors.append(
                        self._kemfai_issue(
                            "CURRENCY_DISABLED",
                            line=line,
                            field="transaction_currency_code",
                            resource_id=configuration.public_id,
                        )
                    )
                if configuration.version != line["currencyConfigurationVersion"]:
                    errors.append(
                        self._kemfai_issue(
                            "CONFIGURATION_STALE",
                            line=line,
                            field="currency_configuration_version",
                            resource_id=configuration.public_id,
                        )
                    )
                if (
                    configuration.native_metadata_version
                    != line["transactionCurrencyMetadataVersion"]
                    or configuration.native_decimal_places
                    != line["transactionPrecision"]
                ):
                    errors.append(
                        self._kemfai_issue(
                            "CURRENCY_METADATA_STALE",
                            line=line,
                            field="transaction_currency_metadata_version",
                            resource_id=configuration.public_id,
                        )
                    )

            is_foreign = (
                line["transactionCurrencyCode"]
                != line["companyBaseCurrencyCode"]
            )
            if is_foreign:
                if not line.get("rateReference"):
                    errors.append(
                        self._kemfai_issue(
                            "FX_RATE_REFERENCE_REQUIRED",
                            line=line,
                            field="rate_reference",
                        )
                    )
                if not line.get("rateEffectiveDate"):
                    errors.append(
                        self._kemfai_issue(
                            "FX_RATE_EFFECTIVE_DATE_REQUIRED",
                            line=line,
                            field="rate_effective_date",
                        )
                    )
            elif line.get("rateReference") is not None or line.get(
                "rateEffectiveDate"
            ) is not None:
                errors.append(
                    self._kemfai_issue(
                        "BASE_CURRENCY_FX_PROVENANCE_FORBIDDEN",
                        line=line,
                        field="rate_reference",
                    )
                )

        if base_debit_total != base_credit_total:
            errors.append(
                self._kemfai_issue("BASE_TOTALS_UNBALANCED", field="base_totals")
            )

        total_format = f".{{scale}}f"
        base_currency_code = lines[0]["companyBaseCurrencyCode"]
        base_precision = lines[0]["basePrecision"]
        return {
            "errors": errors,
            "policy_blockers": policy_blockers,
            "checks_performed": checks,
            "configuration_versions": configuration_versions,
            "base_debit_total": format(
                base_debit_total, total_format.format(scale=base_scale)
            ),
            "base_credit_total": format(
                base_credit_total, total_format.format(scale=base_scale)
            ),
            "company_base_currency_code": base_currency_code,
            "base_precision": base_precision,
        }

    @api.model
    def _kemfai_draft_result(
        self, draft, errors=None, rule_versions=None, details=None
    ):
        payload = draft.payload_json
        result = {
            "id": draft.public_id,
            "company_id": draft.company_id.id,
            "version": draft.version,
            "status": "draft",
            "journal_id": payload["journalId"],
            "accounting_date": payload["accountingDate"],
            "description": payload["description"],
            "transaction_type": "manual_journal",
            "source": payload.get("source"),
            "lines": [
                self._kemfai_line_result(line, draft.company_id)
                for line in payload["lines"]
            ],
            "validation_state": draft.validation_state,
            "errors": errors or [],
            "rule_versions": rule_versions or [],
            "ledger_effect": "none",
        }
        if details:
            result.update(details)
        return result

    @api.model
    def _kemfai_finish(
        self,
        operation_uuid,
        action,
        actor_identity,
        draft,
        before,
        errors=None,
        rule_versions=None,
        details=None,
    ):
        result = self._kemfai_draft_result(draft, errors, rule_versions, details)
        event = self.env["kemfai.account.audit.event"].kemfai_append(
            operation_uuid=operation_uuid,
            action=action,
            actor_identity=actor_identity,
            company_id=draft.company_id.id,
            resource_model="kemfai.account.draft",
            resource_public_id=draft.public_id,
            before=before,
            after=result,
        )
        result = dict(result, audit_event_id=event.public_id)
        self.env["kemfai.account.mutation.receipt"].kemfai_record_result(
            operation_uuid=operation_uuid,
            action=action,
            actor_identity=actor_identity,
            company_id=draft.company_id.id,
            audit_event_uuid=event.public_id,
            result=result,
        )
        return result

    @api.model
    @operation_race_retry(0)
    def kemfai_save_minimal_draft(
        self, operation_uuid, actor_identity, company_id, values
    ):
        replay = self.env["kemfai.account.mutation.receipt"].kemfai_find_result(
            operation_uuid
        )
        if replay:
            return replay
        company = self._kemfai_company(company_id)
        payload = self._kemfai_payload(values)
        # Save is deliberately non-posting and preserves invalid selections for the
        # explicit receipt-bearing validation step. Cross-company disclosure still fails.
        for line in payload["lines"]:
            account = self._kemfai_account(line["accountId"])
            if account and account.company_id != company:
                raise ValidationError("ACCOUNT_COMPANY_MISMATCH")
        draft = self.create(
            {
                "company_id": company.id,
                "actor_identity": actor_identity,
                "status": "draft",
                "version": 1,
                "validation_state": "not_validated",
                "payload_json": payload,
            }
        )
        return self._kemfai_finish(
            operation_uuid, "draft.save", actor_identity, draft, None
        )

    @api.model
    @operation_race_retry(0)
    def kemfai_update_minimal_draft(
        self,
        operation_uuid,
        actor_identity,
        public_id,
        expected_version,
        company_id,
        values,
    ):
        replay = self.env["kemfai.account.mutation.receipt"].kemfai_find_result(
            operation_uuid
        )
        if replay:
            return replay
        company = self._kemfai_company(company_id)
        draft = self._kemfai_draft_for_update(public_id, company_id)
        if draft.version != expected_version:
            raise ValidationError("STALE_VERSION")
        payload = self._kemfai_payload(values)
        for line in payload["lines"]:
            account = self._kemfai_account(line["accountId"])
            if account and account.company_id != company:
                raise ValidationError("ACCOUNT_COMPANY_MISMATCH")

        before = self._kemfai_draft_result(draft)
        source = payload.get("source") or {}
        journal = self.env["account.journal"].with_context(active_test=False).search(
            [
                ("kemfai_public_id", "=", payload["journalId"]),
                ("company_id", "=", company.id),
            ],
            limit=1,
        )
        draft.line_ids.unlink()
        draft.write(
            {
                "actor_identity": actor_identity,
                "journal_id": journal.id or False,
                "accounting_date": payload["accountingDate"],
                "description": payload["description"],
                "transaction_type_key": payload["transactionType"],
                "source_type": source.get("type") or False,
                "source_public_id": source.get("id") or False,
                "payload_json": payload,
                "version": draft.version + 1,
                "validation_state": "stale",
            }
        )

        line_values = []
        for line in payload["lines"]:
            account = self._kemfai_account(line["accountId"])
            if not (
                account
                and account.company_id == company
                and account.active
                and account.kemfai_node_kind == "posting"
            ):
                continue
            configuration = self.env[
                "kemfai.account.currency.config"
            ].with_context(active_test=False).search(
                [
                    ("company_id", "=", company.id),
                    ("currency_code", "=", line["transactionCurrencyCode"]),
                ],
                limit=1,
            )
            line_values.append(
                {
                    "public_id": line["id"],
                    "draft_id": draft.id,
                    "account_id": account.id,
                    "sequence": line["sequence"],
                    "description": line.get("description") or False,
                    "currency_config_id": configuration.public_id
                    if configuration
                    else False,
                    "transaction_currency_code": line["transactionCurrencyCode"],
                    "transaction_precision": line["transactionPrecision"],
                    "transaction_currency_metadata_version": line[
                        "transactionCurrencyMetadataVersion"
                    ],
                    "company_base_currency_code": line["companyBaseCurrencyCode"],
                    "base_precision": line["basePrecision"],
                    "base_currency_metadata_version": line[
                        "baseCurrencyMetadataVersion"
                    ],
                    "currency_configuration_version": line[
                        "currencyConfigurationVersion"
                    ],
                    "transaction_debit": line["transactionDebit"],
                    "transaction_credit": line["transactionCredit"],
                    "base_debit": line["baseDebit"],
                    "base_credit": line["baseCredit"],
                    "rate_reference": line["rateReference"] or False,
                    "rate_effective_date": line["rateEffectiveDate"] or False,
                    "account_version": account.version,
                    "journal_version": journal.version if journal else False,
                    "source_context": payload.get("source") or False,
                }
            )
        if line_values:
            self.env["kemfai.account.draft.line"].create(line_values)
        return self._kemfai_finish(
            operation_uuid, "draft.update", actor_identity, draft, before
        )

    @api.model
    def kemfai_list_minimal_drafts(self, company_id, filters=None):
        self._kemfai_company(company_id)
        filters = dict(filters or {})
        if set(filters) - {"cursor", "limit"}:
            raise ValidationError("DRAFT_FILTER_INVALID")
        limit = filters.get("limit", 50)
        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or not 1 <= limit <= 200
        ):
            raise ValidationError("DRAFT_LIMIT_INVALID")
        domain = [("company_id", "=", company_id)]
        cursor = filters.get("cursor")
        if cursor:
            cursor_draft = self.search(
                [("public_id", "=", cursor), ("company_id", "=", company_id)],
                limit=1,
            )
            if not cursor_draft:
                raise ValidationError("DRAFT_CURSOR_INVALID")
            domain.append(("id", ">", cursor_draft.id))
        drafts = self.search(domain, order="id", limit=limit + 1)
        page = drafts[:limit]
        return {
            "items": [self._kemfai_draft_result(draft) for draft in page],
            "next_cursor": page[-1].public_id if len(drafts) > limit else None,
        }

    @api.model
    def kemfai_read_minimal_draft(self, public_id, company_id):
        self._kemfai_company(company_id)
        draft = self.search(
            [("public_id", "=", public_id), ("company_id", "=", company_id)],
            limit=1,
        )
        if not draft:
            raise ValidationError("DRAFT_NOT_FOUND")
        return self._kemfai_draft_result(draft)

    @api.model
    @operation_race_retry(0)
    def kemfai_validate_minimal_draft(
        self,
        operation_uuid,
        actor_identity,
        public_id,
        expected_version,
        company_id,
    ):
        replay = self.env["kemfai.account.mutation.receipt"].kemfai_find_result(
            operation_uuid
        )
        if replay:
            return replay
        self._kemfai_company(company_id)
        draft = self._kemfai_draft_for_update(public_id, company_id)
        if draft.version != expected_version:
            raise ValidationError("STALE_VERSION")
        before = self._kemfai_draft_result(draft)
        money_validation = self._kemfai_money_validation(draft)
        errors = list(money_validation["errors"])
        policy_blockers = list(money_validation["policy_blockers"])
        resolved_rules = {}
        for line in draft.payload_json["lines"]:
            account = self._kemfai_account(line["accountId"])
            try:
                self._kemfai_eligible_account(draft.company_id, line["accountId"])
            except ValidationError as error:
                code = str(error.args[0])
                if code not in {"ACCOUNT_NOT_POSTING", "ACCOUNT_INACTIVE"}:
                    raise
                errors.append(
                    {
                        "code": code,
                        "message_key": code,
                        "line_id": line["id"],
                        "resource_id": line["accountId"],
                        "field": "accountId",
                    }
                )
            dimension_errors, line_rules = self._kemfai_validate_line_dimensions(
                draft, line, account
            )
            errors.extend(dimension_errors)
            for rule in line_rules:
                resolved_rules[rule["rule_id"]] = rule
        rule_versions = [resolved_rules[key] for key in sorted(resolved_rules)]
        validation_state = (
            "invalid" if errors or policy_blockers else "valid_for_draft"
        )
        draft.write({"validation_state": validation_state})
        validation_run = self.env["kemfai.account.draft.validation"].create(
            {
                "draft_id": draft.id,
                "draft_version": draft.version,
                "status": validation_state,
                "checks_performed": money_validation["checks_performed"],
                "errors": errors,
                "warnings": [],
                "policy_blockers": policy_blockers,
                "base_debit_total": money_validation["base_debit_total"],
                "base_credit_total": money_validation["base_credit_total"],
                "company_base_currency_code": money_validation[
                    "company_base_currency_code"
                ],
                "base_precision": money_validation["base_precision"],
                "ledger_effect": "none",
                "rule_versions": rule_versions,
                "configuration_versions": money_validation[
                    "configuration_versions"
                ],
                "validated_by": actor_identity,
            }
        )
        details = {
            "validation_run_id": validation_run.public_id,
            "validated_at": validation_run.validated_at.isoformat() + "Z",
            "checks_performed": money_validation["checks_performed"],
            "warnings": [],
            "policy_blockers": policy_blockers,
            "base_debit_total": money_validation["base_debit_total"],
            "base_credit_total": money_validation["base_credit_total"],
            "company_base_currency_code": money_validation[
                "company_base_currency_code"
            ],
            "base_precision": money_validation["base_precision"],
            "configuration_versions": money_validation["configuration_versions"],
        }
        return self._kemfai_finish(
            operation_uuid,
            "draft.validate",
            actor_identity,
            draft,
            before,
            errors,
            rule_versions,
            details,
        )

    @api.model
    def kemfai_create_minimal_draft_line(
        self,
        company_id,
        account_public_id,
        actor_identity,
    ):
        company = self._kemfai_company(company_id)
        account = self._kemfai_eligible_account(company, account_public_id)
        draft = self.create(
            {
                "company_id": company.id,
                "actor_identity": actor_identity,
                "status": "draft",
            }
        )
        line = self.env["kemfai.account.draft.line"].create(
            {"draft_id": draft.id, "account_id": account.id}
        )
        return {"draftId": draft.public_id, "lineId": line.public_id}


class KemfaiAccountDraftLineValidation(models.Model):
    _inherit = "kemfai.account.draft.line"

    @api.constrains("draft_id", "account_id")
    def _check_account_eligibility(self):
        for line in self:
            account = line.account_id
            if account.company_id != line.draft_id.company_id:
                raise ValidationError("ACCOUNT_COMPANY_MISMATCH")
            if not account.active:
                raise ValidationError("ACCOUNT_INACTIVE")
            if account.kemfai_node_kind != "posting":
                raise ValidationError("ACCOUNT_NOT_POSTING")
