import uuid
from unittest.mock import patch

from odoo.exceptions import ValidationError
from odoo.tests import tagged
from odoo.tests.common import TransactionCase


@tagged("post_install", "-at_install", "kemfai_accounting", "story_1", "no_ledger")
class TestMinimalDraftAccountEligibility(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Account = cls.env["account.account"].with_context(tracking_disable=True)
        cls.Draft = cls.env["kemfai.account.draft"]
        cls.DraftLine = cls.env["kemfai.account.draft.line"]
        cls.company_a = cls.env.company
        cls.company_b = cls.env["res.company"].create({"name": "KEMFAI T023 Company B"})
        cls.actor = "23232323-1111-4111-8111-111111111111"

    def setUp(self):
        super().setUp()
        self.move_count = self.env["account.move"].search_count([])
        self.move_line_count = self.env["account.move.line"].search_count([])

    def _account(self, company, code, kind="posting", active=True, parent=None):
        values = {
            "name": f"Account {code}",
            "name_en": f"Account {code}",
            "name_ar": f"حساب {code}",
            "code": code,
            "account_type": "asset_current",
            "company_id": company.id,
            "kemfai_node_kind": kind,
            "active": active,
        }
        if parent:
            values["kemfai_parent_id"] = parent.id
        return self.Account.create(values)

    def _create_minimal(self, account, company=None):
        return self.Draft.kemfai_create_minimal_draft_line(
            (company or self.company_a).id,
            account.kemfai_public_id,
            self.actor,
        )

    def _assert_no_ledger_effect(self):
        self.assertEqual(self.move_count, self.env["account.move"].search_count([]))
        self.assertEqual(
            self.move_line_count, self.env["account.move.line"].search_count([])
        )

    def test_active_posting_child_is_accepted_as_draft_line_without_ledger_effect(self):
        parent = self._account(self.company_a, "T023.100", kind="parent")
        posting = self._account(self.company_a, "T023.101", parent=parent)
        result = self._create_minimal(posting)
        draft = self.Draft.search([("public_id", "=", result["draftId"])])
        line = self.DraftLine.search([("public_id", "=", result["lineId"])])
        self.assertTrue(draft and line)
        self.assertEqual("draft", draft.status)
        self.assertEqual(posting, line.account_id)
        self.assertEqual(self.company_a, draft.company_id)
        self._assert_no_ledger_effect()

    def test_parent_account_is_rejected_with_stable_code_and_no_ledger_effect(self):
        parent = self._account(self.company_a, "T023.200", kind="parent")
        with self.assertRaisesRegex(ValidationError, "ACCOUNT_NOT_POSTING"):
            self._create_minimal(parent)
        self._assert_no_ledger_effect()

    def test_inactive_posting_account_is_rejected_and_no_ledger_effect(self):
        inactive = self._account(self.company_a, "T023.300", active=False)
        with self.assertRaisesRegex(ValidationError, "ACCOUNT_INACTIVE"):
            self._create_minimal(inactive)
        self._assert_no_ledger_effect()

    def test_cross_company_account_is_rejected_and_no_ledger_effect(self):
        foreign = self._account(self.company_b, "T023.400")
        with self.assertRaisesRegex(ValidationError, "ACCOUNT_COMPANY_MISMATCH"):
            self._create_minimal(foreign, company=self.company_a)
        self._assert_no_ledger_effect()

    def test_guarded_save_read_validate_parent_rejection_is_receipt_bearing(self):
        parent = self._account(self.company_a, "T051.500", kind="parent")
        draft_operation = str(uuid.uuid4())
        validation_operation = str(uuid.uuid4())
        line_id = str(uuid.uuid4())
        body = {
            "journalId": str(uuid.uuid4()),
            "accountingDate": "2026-11-03",
            "description": "exact parent validation",
            "transactionType": "manual_journal",
            "source": None,
            "lines": [
                {
                    "id": line_id,
                    "sequence": 1,
                    "accountId": parent.kemfai_public_id,
                    "transactionCurrencyCode": "AED",
                    "transactionPrecision": 2,
                    "transactionCurrencyMetadataVersion": "v1",
                    "companyBaseCurrencyCode": "AED",
                    "basePrecision": 2,
                    "baseCurrencyMetadataVersion": "v1",
                    "currencyConfigurationVersion": 1,
                    "transactionDebit": "1.2300",
                    "transactionCredit": "0",
                    "baseDebit": "1.2300",
                    "baseCredit": "0",
                    "rateReference": None,
                    "rateEffectiveDate": None,
                    "dimensions": [],
                }
            ],
        }

        saved = self.Draft.kemfai_save_minimal_draft(
            draft_operation, self.actor, self.company_a.id, body
        )
        read = self.Draft.kemfai_read_minimal_draft(saved["id"], self.company_a.id)
        self.assertEqual("1.2300", read["lines"][0]["transaction_debit"])
        self.assertEqual(parent.kemfai_public_id, read["lines"][0]["account_id"])
        page = self.Draft.kemfai_list_minimal_drafts(
            self.company_a.id, {"limit": 1}
        )
        self.assertEqual([saved["id"]], [item["id"] for item in page["items"]])
        self.assertIsNone(page["next_cursor"])

        validated = self.Draft.kemfai_validate_minimal_draft(
            validation_operation,
            self.actor,
            saved["id"],
            saved["version"],
            self.company_a.id,
        )
        self.assertEqual("none", validated["ledger_effect"])
        self.assertEqual("invalid", validated["validation_state"])
        parent_issues = [
            issue
            for issue in validated["errors"]
            if issue["code"] == "ACCOUNT_NOT_POSTING"
        ]
        self.assertEqual(1, len(parent_issues), validated["errors"])
        self.assertEqual(line_id, parent_issues[0]["line_id"])
        self.assertEqual(1, self.env["kemfai.account.mutation.receipt"].search_count(
            [("operation_uuid", "=", draft_operation)]
        ))
        self.assertEqual(1, self.env["kemfai.account.mutation.receipt"].search_count(
            [("operation_uuid", "=", validation_operation)]
        ))
        self.assertEqual(1, self.env["kemfai.account.audit.event"].search_count(
            [("operation_uuid", "=", validation_operation)]
        ))
        self._assert_no_ledger_effect()


@tagged("post_install", "-at_install", "kemfai_accounting", "story_2", "no_ledger")
class TestDraftDimensionAssignments(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Account = cls.env["account.account"].with_context(tracking_disable=True)
        cls.Definition = cls.env["kemfai.dimension.definition"]
        cls.Value = cls.env["kemfai.dimension.value"]
        cls.Rule = cls.env["kemfai.dimension.rule"]
        cls.Draft = cls.env["kemfai.account.draft"]
        cls.company = cls.env.company
        cls.other_company = cls.env["res.company"].create(
            {"name": "KEMFAI T074 Company B"}
        )
        cls.account = cls.Account.create(
            {
                "name": "T074 Draft Expense",
                "name_en": "T074 Draft Expense",
                "name_ar": "مصروف مسودة T074",
                "code": "T074.100",
                "account_type": "expense",
                "company_id": cls.company.id,
                "kemfai_node_kind": "posting",
            }
        )
        cls.actor = "74747474-1111-4111-8111-111111111111"

    def setUp(self):
        super().setUp()
        self.move_count = self.env["account.move"].search_count([])
        self.move_line_count = self.env["account.move.line"].search_count([])

    def _definition(self, key, *, company=None):
        company = company or self.company
        return self.Definition.create(
            {
                "company_id": company.id,
                "key": key,
                "kind": "built_in",
                "name_en": key.replace("_", " ").title(),
                "name_ar": f"بُعد {key}",
            }
        )

    def _value(self, definition, code, *, active=True):
        return self.Value.create(
            {
                "company_id": definition.company_id.id,
                "definition_id": definition.id,
                "code": code,
                "name_en": code,
                "name_ar": f"قيمة {code}",
                "active": active,
            }
        )

    def _rule(self, definition, requirement):
        return self.Rule.create(
            {
                "company_id": self.company.id,
                "account_id": self.account.id,
                "transaction_type_key": "manual_journal",
                "dimension_definition_id": definition.id,
                "requirement": requirement,
                "effective_from": "2026-01-01",
            }
        )

    def _payload(self, dimensions):
        return {
            "journalId": str(uuid.uuid4()),
            "accountingDate": "2026-11-06",
            "description": "T074 dimension validation",
            "transactionType": "manual_journal",
            "source": None,
            "lines": [
                {
                    "id": str(uuid.uuid4()),
                    "sequence": 1,
                    "accountId": self.account.kemfai_public_id,
                    "transactionCurrencyCode": "AED",
                    "transactionPrecision": 2,
                    "transactionCurrencyMetadataVersion": "v1",
                    "companyBaseCurrencyCode": "AED",
                    "basePrecision": 2,
                    "baseCurrencyMetadataVersion": "v1",
                    "currencyConfigurationVersion": 1,
                    "transactionDebit": "10.00",
                    "transactionCredit": "0",
                    "baseDebit": "10.00",
                    "baseCredit": "0",
                    "rateReference": None,
                    "rateEffectiveDate": None,
                    "dimensions": dimensions,
                }
            ],
        }

    @staticmethod
    def _assignment(definition, value):
        return {"definitionId": definition.public_id, "valueId": value.public_id}

    def _save_and_validate(self, dimensions, *, after_save=None):
        saved = self.Draft.kemfai_save_minimal_draft(
            str(uuid.uuid4()),
            self.actor,
            self.company.id,
            self._payload(dimensions),
        )
        if after_save:
            after_save()
        result = self.Draft.kemfai_validate_minimal_draft(
            str(uuid.uuid4()),
            self.actor,
            saved["id"],
            saved["version"],
            self.company.id,
        )
        self.assertEqual("draft", result["status"])
        self.assertEqual("none", result["ledger_effect"])
        self.assertNotIn("post", result)
        return result

    def _assert_no_ledger_effect(self):
        self.assertEqual(self.move_count, self.env["account.move"].search_count([]))
        self.assertEqual(
            self.move_line_count, self.env["account.move.line"].search_count([])
        )

    def _assert_issue(self, result, code, definition, *, value=None):
        issues = [issue for issue in result["errors"] if issue["code"] == code]
        self.assertEqual(1, len(issues), result["errors"])
        issue = issues[0]
        self.assertEqual(result["lines"][0]["id"], issue["line_id"])
        self.assertEqual("dimensions", issue["field"])
        self.assertEqual(
            value.public_id if value else definition.public_id,
            issue["resource_id"],
        )

    def test_required_assignment_missing_reports_issue_and_stays_non_postable(self):
        project = self._definition("project_t074_required")
        rule = self._rule(project, "required")

        result = self._save_and_validate([])

        self.assertEqual("invalid", result["validation_state"])
        self._assert_issue(result, "DIMENSION_REQUIRED", project)
        self.assertEqual(
            [
                {
                    "rule_id": rule.public_id,
                    "rule_version": rule.version,
                    "dimension_definition_id": project.public_id,
                    "dimension_definition_version": project.version,
                    "requirement": "required",
                }
            ],
            result["rule_versions"],
        )
        self.assertFalse(hasattr(self.Draft, "action_post"))
        self._assert_no_ledger_effect()

    def test_prohibited_assignment_reports_issue_without_ledger_effect(self):
        department = self._definition("department_t074_prohibited")
        department_value = self._value(department, "FIN")
        self._rule(department, "prohibited")

        result = self._save_and_validate(
            [self._assignment(department, department_value)]
        )

        self.assertEqual("invalid", result["validation_state"])
        self._assert_issue(
            result, "DIMENSION_PROHIBITED", department, value=department_value
        )
        self._assert_no_ledger_effect()

    def test_inactive_value_is_preserved_for_history_but_fails_revalidation(self):
        cost_center = self._definition("cost_center_t074_inactive")
        cost_center_value = self._value(cost_center, "CC-01")
        self._rule(cost_center, "optional")

        result = self._save_and_validate(
            [self._assignment(cost_center, cost_center_value)],
            after_save=lambda: cost_center_value.write({"active": False}),
        )

        self.assertEqual("invalid", result["validation_state"])
        self._assert_issue(
            result, "DIMENSION_INACTIVE", cost_center, value=cost_center_value
        )
        self.assertEqual(
            cost_center_value.public_id,
            result["lines"][0]["dimensions"][0]["value_id"],
        )
        self._assert_no_ledger_effect()

    def test_foreign_company_assignment_is_reported_without_disclosing_foreign_data(self):
        foreign_project = self._definition(
            "project_t074_foreign", company=self.other_company
        )
        foreign_value = self._value(foreign_project, "FOREIGN")

        result = self._save_and_validate(
            [self._assignment(foreign_project, foreign_value)]
        )

        self.assertEqual("invalid", result["validation_state"])
        self._assert_issue(
            result, "DIMENSION_OUT_OF_SCOPE", foreign_project, value=foreign_value
        )
        issue = result["errors"][0]
        self.assertNotIn("name", issue)
        self.assertNotIn("code", issue.get("message_params", {}))
        self._assert_no_ledger_effect()

    def test_validation_returns_all_dimension_issues_in_one_non_posting_result(self):
        required = self._definition("project_t074_all")
        prohibited = self._definition("department_t074_all")
        inactive = self._definition("cost_center_t074_all")
        foreign = self._definition("branch_t074_all", company=self.other_company)
        prohibited_value = self._value(prohibited, "NO-DEPT")
        inactive_value = self._value(inactive, "OLD-CC")
        foreign_value = self._value(foreign, "FOREIGN-BRANCH")
        self._rule(required, "required")
        self._rule(prohibited, "prohibited")
        self._rule(inactive, "optional")

        result = self._save_and_validate(
            [
                self._assignment(prohibited, prohibited_value),
                self._assignment(inactive, inactive_value),
                self._assignment(foreign, foreign_value),
            ],
            after_save=lambda: inactive_value.write({"active": False}),
        )

        self.assertEqual("invalid", result["validation_state"])
        expected_dimension_codes = {
            "DIMENSION_REQUIRED",
            "DIMENSION_PROHIBITED",
            "DIMENSION_INACTIVE",
            "DIMENSION_OUT_OF_SCOPE",
        }
        dimension_issues = [
            issue
            for issue in result["errors"]
            if issue["code"] in expected_dimension_codes
        ]
        self.assertEqual(
            expected_dimension_codes,
            {issue["code"] for issue in dimension_issues},
        )
        self.assertEqual(4, len(dimension_issues))
        self.assertEqual("draft", result["status"])
        self.assertFalse(hasattr(self.Draft, "action_post"))
        self._assert_no_ledger_effect()

@tagged("post_install", "-at_install", "kemfai_accounting", "story_3", "no_ledger")
class TestDraftExactMoneySnapshots(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Draft = cls.env["kemfai.account.draft"]
        cls.DraftLine = cls.env["kemfai.account.draft.line"]
        cls.Configuration = cls.env["kemfai.account.currency.config"]
        cls.company = cls.env.company
        cls.actor = "10810810-8111-4111-8111-111111111111"
        cls.account = cls.env["account.account"].with_context(
            tracking_disable=True
        ).create(
            {
                "name": "T108 Exact Money",
                "name_en": "T108 Exact Money",
                "name_ar": "مبالغ دقيقة T108",
                "code": "T108.100",
                "account_type": "asset_current",
                "company_id": cls.company.id,
                "kemfai_node_kind": "posting",
            }
        )
        cls.journal = cls.env["account.journal"].create(
            {
                "company_id": cls.company.id,
                "code": "T108",
                "name": "T108 Draft Journal",
                "name_en": "T108 Draft Journal",
                "name_ar": "دفتر مسودة T108",
                "type": "general",
            }
        )
        cls.base_currency = cls.company.currency_id
        cls.foreign_currency = cls.env["res.currency"].with_context(
            active_test=False
        ).search([("id", "!=", cls.base_currency.id)], limit=1)
        if not cls.foreign_currency:
            raise AssertionError("T108 requires a second native currency fixture")
        cls.base_configuration = cls.Configuration.kemfai_put_currency_configuration(
            cls.company.id,
            cls.base_currency.name,
            str(uuid.uuid4()),
            cls.actor,
            "*",
            {"enabled": True},
        )
        cls.foreign_configuration = (
            cls.Configuration.kemfai_put_currency_configuration(
                cls.company.id,
                cls.foreign_currency.name,
                str(uuid.uuid4()),
                cls.actor,
                "*",
                {"enabled": True},
            )
        )

    def _line(
        self,
        *,
        line_id,
        currency,
        configuration,
        transaction_debit,
        transaction_credit,
        base_debit,
        base_credit,
        rate_reference,
        rate_effective_date,
    ):
        return {
            "id": line_id,
            "sequence": 1,
            "accountId": self.account.kemfai_public_id,
            "description": "T108 exact line",
            "transactionCurrencyCode": currency.name,
            "transactionPrecision": currency.decimal_places,
            "transactionCurrencyMetadataVersion": configuration[
                "native_metadata_version"
            ],
            "companyBaseCurrencyCode": self.base_currency.name,
            "basePrecision": self.base_currency.decimal_places,
            "baseCurrencyMetadataVersion": self.base_configuration[
                "native_metadata_version"
            ],
            "currencyConfigurationVersion": configuration["version"],
            "transactionDebit": transaction_debit,
            "transactionCredit": transaction_credit,
            "baseDebit": base_debit,
            "baseCredit": base_credit,
            "rateReference": rate_reference,
            "rateEffectiveDate": rate_effective_date,
            "dimensions": [],
        }

    def _save(self, line):
        payload = {
            "journalId": self.journal.kemfai_public_id,
            "accountingDate": "2026-11-07",
            "description": "T108 exact draft",
            "transactionType": "manual_journal",
            "source": {"type": "manual_evidence", "id": str(uuid.uuid4())},
            "lines": [line],
        }
        saved = self.Draft.kemfai_save_minimal_draft(
            str(uuid.uuid4()), self.actor, self.company.id, payload
        )
        read = self.Draft.kemfai_read_minimal_draft(saved["id"], self.company.id)
        persisted = self.DraftLine.search([("public_id", "=", line["id"])])
        self.assertEqual(1, len(persisted))
        return read["lines"][0], persisted

    def test_exact_decimal_lexemes_and_excess_scale_round_trip_byte_for_value(self):
        line_id = str(uuid.uuid4())
        submitted = self._line(
            line_id=line_id,
            currency=self.base_currency,
            configuration=self.base_configuration,
            transaction_debit="10.2300",
            transaction_credit="0.000",
            base_debit="10.2300",
            base_credit="0.000",
            rate_reference=None,
            rate_effective_date=None,
        )

        returned, persisted = self._save(submitted)

        for public_key, model_field in (
            ("transactionDebit", "transaction_debit"),
            ("transactionCredit", "transaction_credit"),
            ("baseDebit", "base_debit"),
            ("baseCredit", "base_credit"),
        ):
            self.assertEqual(submitted[public_key], returned[model_field])
            self.assertEqual(submitted[public_key], persisted[model_field])

    def test_currency_and_native_metadata_snapshots_are_persisted_unchanged(self):
        line_id = str(uuid.uuid4())
        submitted = self._line(
            line_id=line_id,
            currency=self.foreign_currency,
            configuration=self.foreign_configuration,
            transaction_debit="5.0000",
            transaction_credit="0",
            base_debit="18.7654321",
            base_credit="0",
            rate_reference="bank-file:T108-row-7",
            rate_effective_date="2026-11-06",
        )

        returned, persisted = self._save(submitted)

        for public_key, model_field in (
            ("transactionCurrencyCode", "transaction_currency_code"),
            ("transactionPrecision", "transaction_precision"),
            (
                "transactionCurrencyMetadataVersion",
                "transaction_currency_metadata_version",
            ),
            ("companyBaseCurrencyCode", "company_base_currency_code"),
            ("basePrecision", "base_precision"),
            ("baseCurrencyMetadataVersion", "base_currency_metadata_version"),
            ("currencyConfigurationVersion", "currency_configuration_version"),
        ):
            self.assertEqual(submitted[public_key], returned[model_field])
            self.assertEqual(submitted[public_key], persisted[model_field])

    def test_base_currency_provenance_is_explicitly_null(self):
        submitted = self._line(
            line_id=str(uuid.uuid4()),
            currency=self.base_currency,
            configuration=self.base_configuration,
            transaction_debit="1.00",
            transaction_credit="0",
            base_debit="1.00",
            base_credit="0",
            rate_reference=None,
            rate_effective_date=None,
        )

        returned, persisted = self._save(submitted)

        self.assertIsNone(returned["rate_reference"])
        self.assertIsNone(returned["rate_effective_date"])
        self.assertFalse(persisted.rate_reference)
        self.assertFalse(persisted.rate_effective_date)

    def test_foreign_provenance_pair_and_caller_base_amount_are_not_derived(self):
        submitted = self._line(
            line_id=str(uuid.uuid4()),
            currency=self.foreign_currency,
            configuration=self.foreign_configuration,
            transaction_debit="10.2300",
            transaction_credit="0",
            base_debit="37.71991",
            base_credit="0.0000",
            rate_reference="manual-approved-source:T108",
            rate_effective_date="2026-11-05",
        )

        returned, persisted = self._save(submitted)

        self.assertEqual(submitted["rateReference"], returned["rate_reference"])
        self.assertEqual(
            submitted["rateEffectiveDate"], returned["rate_effective_date"]
        )
        self.assertEqual(submitted["rateReference"], persisted.rate_reference)
        self.assertEqual(
            submitted["rateEffectiveDate"], str(persisted.rate_effective_date)
        )
        self.assertEqual("10.2300", returned["transaction_debit"])
        self.assertEqual("37.71991", returned["base_debit"])
        self.assertFalse(hasattr(persisted, "exchange_rate"))
        self.assertFalse(hasattr(persisted, "derived_base_debit"))


    def test_update_replaces_exact_lines_increments_version_and_rejects_stale_write(self):
        original = self._line(
            line_id=str(uuid.uuid4()),
            currency=self.base_currency,
            configuration=self.base_configuration,
            transaction_debit="1.2300",
            transaction_credit="0",
            base_debit="1.2300",
            base_credit="0",
            rate_reference=None,
            rate_effective_date=None,
        )
        payload = {
            "journalId": self.journal.kemfai_public_id,
            "accountingDate": "2026-11-07",
            "description": "before update",
            "transactionType": "manual_journal",
            "source": None,
            "lines": [original],
        }
        saved = self.Draft.kemfai_save_minimal_draft(
            str(uuid.uuid4()), self.actor, self.company.id, payload
        )
        replacement = self._line(
            line_id=str(uuid.uuid4()),
            currency=self.foreign_currency,
            configuration=self.foreign_configuration,
            transaction_debit="9.876500",
            transaction_credit="0.000000",
            base_debit="36.2811375",
            base_credit="0.0000000",
            rate_reference="owner-supplied:T127",
            rate_effective_date="2026-11-07",
        )
        changed = dict(payload, description="after update", lines=[replacement])

        updated = self.Draft.kemfai_update_minimal_draft(
            str(uuid.uuid4()),
            self.actor,
            saved["id"],
            saved["version"],
            self.company.id,
            changed,
        )

        self.assertEqual(2, updated["version"])
        self.assertEqual("stale", updated["validation_state"])
        self.assertEqual("9.876500", updated["lines"][0]["transaction_debit"])
        self.assertEqual("36.2811375", updated["lines"][0]["base_debit"])
        self.assertFalse(self.DraftLine.search([("public_id", "=", original["id"])]))
        persisted = self.DraftLine.search([("public_id", "=", replacement["id"])])
        self.assertEqual("9.876500", persisted.transaction_debit)
        self.assertEqual("36.2811375", persisted.base_debit)
        with self.assertRaisesRegex(ValidationError, "STALE_VERSION"):
            self.Draft.kemfai_update_minimal_draft(
                str(uuid.uuid4()),
                self.actor,
                saved["id"],
                saved["version"],
                self.company.id,
                changed,
            )


@tagged("post_install", "-at_install", "kemfai_accounting", "story_3", "no_ledger")
class TestDraftValidationPreviewAndSafety(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Draft = cls.env["kemfai.account.draft"]
        cls.ValidationRun = cls.env["kemfai.account.draft.validation"]
        cls.Receipt = cls.env["kemfai.account.mutation.receipt"]
        cls.Event = cls.env["kemfai.account.audit.event"]
        cls.Configuration = cls.env["kemfai.account.currency.config"]
        cls.company = cls.env.company
        cls.actor = "10910910-9111-4111-8111-111111111111"
        cls.account = cls.env["account.account"].with_context(
            tracking_disable=True
        ).create(
            {
                "name": "T109 Draft Expense",
                "name_en": "T109 Draft Expense",
                "name_ar": "مصروف مسودة T109",
                "code": "T109.100",
                "account_type": "expense",
                "company_id": cls.company.id,
                "kemfai_node_kind": "posting",
            }
        )
        cls.journal = cls.env["account.journal"].create(
            {
                "company_id": cls.company.id,
                "code": "T109",
                "name": "T109 Draft Journal",
                "name_en": "T109 Draft Journal",
                "name_ar": "دفتر مسودة T109",
                "type": "general",
            }
        )
        cls.currency = cls.company.currency_id
        cls.configuration = cls.Configuration.kemfai_put_currency_configuration(
            cls.company.id,
            cls.currency.name,
            str(uuid.uuid4()),
            cls.actor,
            "*",
            {"enabled": True},
        )

    def setUp(self):
        super().setUp()
        self.move_count = self.env["account.move"].search_count([])
        self.move_line_count = self.env["account.move.line"].search_count([])

    def _line(self, *, sequence, debit, credit):
        return {
            "id": str(uuid.uuid4()),
            "sequence": sequence,
            "accountId": self.account.kemfai_public_id,
            "description": f"T109 exact line {sequence}",
            "transactionCurrencyCode": self.currency.name,
            "transactionPrecision": self.currency.decimal_places,
            "transactionCurrencyMetadataVersion": self.configuration[
                "native_metadata_version"
            ],
            "companyBaseCurrencyCode": self.currency.name,
            "basePrecision": self.currency.decimal_places,
            "baseCurrencyMetadataVersion": self.configuration[
                "native_metadata_version"
            ],
            "currencyConfigurationVersion": self.configuration["version"],
            "transactionDebit": debit,
            "transactionCredit": credit,
            "baseDebit": debit,
            "baseCredit": credit,
            "rateReference": None,
            "rateEffectiveDate": None,
            "dimensions": [],
        }

    def _save(self, lines):
        return self.Draft.kemfai_save_minimal_draft(
            str(uuid.uuid4()),
            self.actor,
            self.company.id,
            {
                "journalId": self.journal.kemfai_public_id,
                "accountingDate": "2026-11-07",
                "description": "T109 validation preview",
                "transactionType": "manual_journal",
                "source": {"type": "manual_evidence", "id": str(uuid.uuid4())},
                "lines": lines,
            },
        )

    def _validate(self, saved, operation_uuid=None):
        return self.Draft.kemfai_validate_minimal_draft(
            operation_uuid or str(uuid.uuid4()),
            self.actor,
            saved["id"],
            saved["version"],
            self.company.id,
        )

    def _assert_no_ledger_effect(self, result=None):
        if result is not None:
            self.assertEqual("none", result["ledger_effect"])
            self.assertNotEqual("valid_for_post", result["validation_state"])
            self.assertNotIn("post", result)
        self.assertEqual(self.move_count, self.env["account.move"].search_count([]))
        self.assertEqual(
            self.move_line_count, self.env["account.move.line"].search_count([])
        )
        self.assertFalse(hasattr(self.Draft, "action_post"))

    def test_single_zero_line_is_invalid_for_draft_without_posting(self):
        saved = self._save(
            [self._line(sequence=1, debit="0.00", credit="0.00")]
        )

        result = self._validate(saved)

        self.assertEqual("invalid", result["validation_state"])
        self.assertIn(
            "DRAFT_MINIMUM_LINES_REQUIRED",
            {error["code"] for error in result["errors"]},
        )
        self.assertIn(
            "DRAFT_LINE_AMOUNT_REQUIRED",
            {error["code"] for error in result["errors"]},
        )
        self._assert_no_ledger_effect(result)

    def test_balanced_preview_has_exact_base_totals_and_is_only_valid_for_draft(self):
        saved = self._save(
            [
                self._line(sequence=1, debit="10.2300", credit="0.0000"),
                self._line(sequence=2, debit="0.0000", credit="10.2300"),
            ]
        )

        result = self._validate(saved)

        self.assertEqual("valid_for_draft", result["validation_state"])
        self.assertEqual("10.2300", result["base_debit_total"])
        self.assertEqual("10.2300", result["base_credit_total"])
        self.assertEqual(self.currency.name, result["company_base_currency_code"])
        self.assertEqual(self.currency.decimal_places, result["base_precision"])
        self._assert_no_ledger_effect(result)

    def test_unbalanced_preview_reports_all_exact_totals_without_posting(self):
        saved = self._save(
            [
                self._line(sequence=1, debit="12.50", credit="0.00"),
                self._line(sequence=2, debit="0.00", credit="7.25"),
            ]
        )

        result = self._validate(saved)

        self.assertEqual("invalid", result["validation_state"])
        self.assertEqual("12.50", result["base_debit_total"])
        self.assertEqual("7.25", result["base_credit_total"])
        self.assertIn("BASE_TOTALS_UNBALANCED", {e["code"] for e in result["errors"]})
        self._assert_no_ledger_effect(result)

    def test_excess_scale_is_preserved_and_returns_a_policy_blocker(self):
        submitted = "1.2300001"
        saved = self._save(
            [
                self._line(sequence=1, debit=submitted, credit="0.0000000"),
                self._line(sequence=2, debit="0.0000000", credit=submitted),
            ]
        )

        result = self._validate(saved)

        self.assertEqual(submitted, result["lines"][0]["base_debit"])
        self.assertEqual(submitted, result["lines"][1]["base_credit"])
        self.assertIn(
            "AMOUNT_SCALE_EXCEEDS_METADATA",
            {blocker["code"] for blocker in result["policy_blockers"]},
        )
        self.assertEqual("invalid", result["validation_state"])
        self._assert_no_ledger_effect(result)

    def test_currency_configuration_change_makes_saved_snapshot_stale(self):
        saved = self._save(
            [
                self._line(sequence=1, debit="2.00", credit="0.00"),
                self._line(sequence=2, debit="0.00", credit="2.00"),
            ]
        )
        self.Configuration.kemfai_put_currency_configuration(
            self.company.id,
            self.currency.name,
            str(uuid.uuid4()),
            self.actor,
            f'"{self.configuration["version"]}"',
            {"enabled": False},
        )

        result = self._validate(saved)

        codes = {issue["code"] for issue in result["errors"]}
        self.assertIn("CONFIGURATION_STALE", codes)
        self.assertIn("CURRENCY_DISABLED", codes)
        self.assertEqual("invalid", result["validation_state"])
        self._assert_no_ledger_effect(result)

    def test_inactive_journal_is_rejected_but_historical_draft_remains(self):
        saved = self._save(
            [
                self._line(sequence=1, debit="3.00", credit="0.00"),
                self._line(sequence=2, debit="0.00", credit="3.00"),
            ]
        )
        self.env["account.journal"].kemfai_update_journal(
            self.journal.kemfai_public_id,
            str(uuid.uuid4()),
            self.actor,
            self.journal.version,
            {"active": False},
            self.company.id,
        )

        result = self._validate(saved)

        self.assertIn("JOURNAL_INACTIVE", {e["code"] for e in result["errors"]})
        self.assertEqual(saved["id"], result["id"])
        self.assertEqual("invalid", result["validation_state"])
        self._assert_no_ledger_effect(result)

    def test_audit_failure_rolls_back_validation_run_receipt_and_draft_state(self):
        saved = self._save(
            [
                self._line(sequence=1, debit="4.00", credit="0.00"),
                self._line(sequence=2, debit="0.00", credit="4.00"),
            ]
        )
        operation_uuid = str(uuid.uuid4())
        before_runs = self.ValidationRun.search_count([])
        draft = self.Draft.search([("public_id", "=", saved["id"])])
        self.assertEqual("not_validated", draft.validation_state)

        with patch.object(
            type(self.Event), "create", side_effect=ValidationError("audit down")
        ):
            with self.assertRaisesRegex(ValidationError, "audit down"):
                with self.env.cr.savepoint():
                    self._validate(saved, operation_uuid)

        draft.invalidate_recordset()
        self.assertEqual(before_runs, self.ValidationRun.search_count([]))
        self.assertFalse(
            self.Receipt.search([("operation_uuid", "=", operation_uuid)])
        )
        self.assertFalse(self.Event.search([("operation_uuid", "=", operation_uuid)]))
        self.assertEqual("not_validated", draft.validation_state)
        self._assert_no_ledger_effect()
