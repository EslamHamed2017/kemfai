import threading
import uuid
from datetime import date

from odoo import api
from odoo.exceptions import ValidationError
from odoo.service.model import retrying
from odoo.sql_db import db_connect
from odoo.tests import tagged
from odoo.tests.common import HttpCase


@tagged("post_install", "-at_install", "kemfai_dimensions", "story_2")
class TestKemfaiDimensionRules(HttpCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Definition = cls.env["kemfai.dimension.definition"]
        cls.Rule = cls.env["kemfai.dimension.rule"]
        cls.company = cls.env.company
        cls.other_company = cls.env["res.company"].create(
            {"name": "KEMFAI T073 Company B"}
        )
        cls.project = cls.Definition.create(
            {
                "company_id": cls.company.id,
                "key": "project_t073",
                "kind": "built_in",
                "name_en": "Project",
                "name_ar": "المشروع",
            }
        )
        cls.account = cls.env["account.account"].create(
            {
                "name": "T073 Expense",
                "code": "T073.100",
                "account_type": "expense",
                "company_ids": [(6, 0, [cls.company.id])],
            }
        )

    def _rule(
        self,
        *,
        definition=None,
        account=None,
        transaction_type=None,
        requirement="required",
        effective_from=date(2026, 1, 1),
        effective_to=None,
        company=None,
    ):
        company = company or self.company
        values = {
            "company_id": company.id,
            "dimension_definition_id": (definition or self.project).id,
            "requirement": requirement,
            "effective_from": effective_from,
            "effective_to": effective_to,
            "active": True,
        }
        if account:
            values["account_id"] = account.id
        if transaction_type:
            values["transaction_type_key"] = transaction_type
        return self.Rule.create(values)

    def _resolve(self, *, account=None, transaction_type=None, on_date=date(2026, 6, 1)):
        return self.Rule.kemfai_resolve_rules(
            company_id=self.company.id,
            account_id=account.id if account else None,
            transaction_type_key=transaction_type,
            effective_on=on_date,
        )

    def _cleanup_committed_race_fixture(self, rule_public_id, definition_public_id):
        with db_connect(self.env.cr.dbname).cursor() as cursor:
            cursor.execute(
                "DELETE FROM kemfai_dimension_rule WHERE public_id = %s",
                [rule_public_id],
            )
            cursor.execute(
                "DELETE FROM kemfai_dimension_definition WHERE public_id = %s",
                [definition_public_id],
            )
            cursor.commit()

    def test_rule_requires_account_or_transaction_type_and_company_scope(self):
        with self.assertRaises(ValidationError):
            self._rule()

        foreign_definition = self.Definition.create(
            {
                "company_id": self.other_company.id,
                "key": "project_t073",
                "kind": "built_in",
                "name_en": "Project",
                "name_ar": "المشروع",
            }
        )
        with self.assertRaises(ValidationError):
            self._rule(definition=foreign_definition, transaction_type="manual_journal")

    def test_rule_requirement_selection_is_exact(self):
        selection = dict(self.Rule._fields["requirement"].selection)
        self.assertEqual({"required", "optional", "prohibited"}, set(selection))

    def test_resolution_uses_most_specific_matching_rule(self):
        transaction_only = self._rule(
            transaction_type="manual_journal", requirement="optional"
        )
        account_only = self._rule(account=self.account, requirement="prohibited")
        both = self._rule(
            account=self.account,
            transaction_type="manual_journal",
            requirement="required",
        )

        resolved = self._resolve(
            account=self.account, transaction_type="manual_journal"
        )
        self.assertEqual(1, len(resolved))
        self.assertEqual(both.public_id, resolved[0]["rule_id"])
        self.assertEqual("required", resolved[0]["requirement"])
        self.assertNotIn(transaction_only.public_id, {item["rule_id"] for item in resolved})
        self.assertNotIn(account_only.public_id, {item["rule_id"] for item in resolved})

    def test_equally_specific_conflicting_active_rules_are_rejected(self):
        self._rule(
            account=self.account,
            transaction_type="manual_journal",
            requirement="required",
        )
        with self.assertRaisesRegex(ValidationError, "DIMENSION_RULE_CONFLICT"):
            self._rule(
                account=self.account,
                transaction_type="manual_journal",
                requirement="prohibited",
            )

    def test_effective_ranges_cannot_overlap_for_the_same_scope(self):
        self._rule(
            transaction_type="purchase_invoice",
            effective_from=date(2026, 1, 1),
            effective_to=date(2026, 1, 31),
        )
        with self.assertRaisesRegex(ValidationError, "DIMENSION_RULE_OVERLAP"):
            self._rule(
                transaction_type="purchase_invoice",
                effective_from=date(2026, 1, 31),
                effective_to=date(2026, 2, 28),
            )
        later = self._rule(
            transaction_type="purchase_invoice",
            effective_from=date(2026, 2, 1),
            effective_to=date(2026, 2, 28),
        )
        self.assertTrue(later)

    def test_resolution_records_exact_rule_and_definition_versions(self):
        rule = self._rule(transaction_type="sales_invoice")
        first = self._resolve(transaction_type="sales_invoice")
        self.assertEqual(
            [
                {
                    "rule_id": rule.public_id,
                    "rule_version": 1,
                    "dimension_definition_id": self.project.public_id,
                    "dimension_definition_version": 1,
                    "requirement": "required",
                }
            ],
            first,
        )

        updated = self.Rule.kemfai_update_rule(
            rule.public_id,
            1,
            {"requirement": "optional"},
        )
        self.assertEqual(2, updated["version"])
        second = self._resolve(transaction_type="sales_invoice")
        self.assertEqual(2, second[0]["rule_version"])
        self.assertEqual("optional", second[0]["requirement"])

    def test_two_transactions_same_version_have_one_winner_and_one_stale_result(self):
        fixture_cursor = db_connect(self.env.cr.dbname).cursor()
        try:
            fixture_env = api.Environment(
                fixture_cursor, self.env.uid, dict(self.env.context)
            )
            definition = fixture_env["kemfai.dimension.definition"].create(
                {
                    "company_id": self.company.id,
                    "key": f"race_{uuid.uuid4().hex[:8]}",
                    "kind": "custom",
                    "name_en": "Race",
                    "name_ar": "سباق",
                }
            )
            rule = fixture_env["kemfai.dimension.rule"].create(
                {
                    "company_id": self.company.id,
                    "dimension_definition_id": definition.id,
                    "transaction_type_key": "manual_journal",
                    "requirement": "required",
                    "effective_from": date(2026, 1, 1),
                }
            )
            public_id = rule.public_id
            definition_public_id = definition.public_id
            starting_version = rule.version
            fixture_cursor.commit()
            self.addCleanup(
                self._cleanup_committed_race_fixture,
                public_id,
                definition_public_id,
            )
        finally:
            fixture_cursor.close()

        barrier = threading.Barrier(2)
        outcomes = []
        failures = []
        lock = threading.Lock()

        def update_in_own_transaction(requirement):
            cursor = db_connect(self.env.cr.dbname).cursor()
            try:
                environment = api.Environment(
                    cursor, self.env.uid, dict(self.env.context)
                )
                model = environment["kemfai.dimension.rule"]
                barrier.wait(timeout=10)
                try:
                    result = retrying(
                        lambda: model.kemfai_update_rule(
                            public_id,
                            starting_version,
                            {"requirement": requirement},
                        ),
                        environment,
                    )
                    cursor.commit()
                    with lock:
                        outcomes.append(result)
                except Exception as error:
                    cursor.rollback()
                    with lock:
                        failures.append(error)
            finally:
                cursor.close()

        threads = [
            threading.Thread(
                target=update_in_own_transaction,
                args=(requirement,),
                daemon=True,
            )
            for requirement in ("optional", "prohibited")
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(1, len(outcomes))
        self.assertEqual(1, len(failures))
        self.assertIsInstance(failures[0], ValidationError)
        self.assertIn("STALE_VERSION", str(failures[0]))
        self.assertEqual(starting_version + 1, outcomes[0]["version"])

        with db_connect(self.env.cr.dbname).cursor() as final_cursor:
            final_env = api.Environment(
                final_cursor, self.env.uid, dict(self.env.context)
            )
            final = final_env["kemfai.dimension.rule"].search(
                [("public_id", "=", public_id)]
            )
            self.assertEqual(starting_version + 1, final.version)
