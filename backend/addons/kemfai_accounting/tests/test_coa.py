import re
import threading
import uuid

from odoo import api

from odoo.exceptions import ValidationError
from odoo.tests import tagged
from odoo.service.model import retrying
from odoo.sql_db import db_connect
from odoo.tests.common import HttpCase


UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


@tagged("post_install", "-at_install", "kemfai_accounting", "story_1")
class TestKemfaiChartOfAccounts(HttpCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Account = cls.env["account.account"].with_context(tracking_disable=True)
        cls.company_a = cls.env.company
        cls.company_b = cls.env["res.company"].create({"name": "KEMFAI T019 Company B"})

    def _account(self, company, code, kind="posting", parent=None, active=True):
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

    def test_company_public_uuid_is_generated_unique_and_immutable_for_t047_routing(self):
        self.assertRegex(self.company_a.kemfai_public_id, UUID_PATTERN)
        self.assertRegex(self.company_b.kemfai_public_id, UUID_PATTERN)
        self.assertNotEqual(self.company_a.kemfai_public_id, self.company_b.kemfai_public_id)
        with self.assertRaises(ValidationError):
            self.company_a.write({"kemfai_public_id": str(uuid.uuid4())})

    def test_public_uuid_is_generated_unique_and_immutable(self):
        first = self._account(self.company_a, "T019.100")
        second = self._account(self.company_a, "T019.101")
        self.assertRegex(first.kemfai_public_id, UUID_PATTERN)
        self.assertRegex(second.kemfai_public_id, UUID_PATTERN)
        self.assertNotEqual(first.kemfai_public_id, second.kemfai_public_id)
        with self.assertRaises(ValidationError):
            first.write({"kemfai_public_id": second.kemfai_public_id})

    def test_code_is_unique_per_company_but_reusable_in_another_company(self):
        self._account(self.company_a, "T019.200")
        with self.assertRaises(ValidationError):
            self._account(self.company_a, "T019.200")
        other = self._account(self.company_b, "T019.200")
        self.assertEqual(other.company_id, self.company_b)

    def test_node_kind_selection_is_exact_and_parent_accepts_posting_child(self):
        selection = dict(self.Account._fields["kemfai_node_kind"].selection)
        self.assertEqual({"parent", "posting"}, set(selection))
        parent = self._account(self.company_a, "T019.300", kind="parent")
        child = self._account(self.company_a, "T019.301", parent=parent)
        self.assertEqual(child.kemfai_parent_id, parent)
        self.assertEqual(child.kemfai_node_kind, "posting")

    def test_posting_account_cannot_be_selected_as_a_parent(self):
        posting = self._account(self.company_a, "T019.400")
        with self.assertRaises(ValidationError):
            self._account(self.company_a, "T019.401", parent=posting)

    def test_parent_link_rejects_self_cycle_and_cross_company(self):
        parent_a = self._account(self.company_a, "T019.500", kind="parent")
        parent_b = self._account(self.company_b, "T019.500", kind="parent")
        child = self._account(self.company_a, "T019.501", parent=parent_a)
        with self.assertRaises(ValidationError):
            child.write({"kemfai_parent_id": child.id})
        with self.assertRaises(ValidationError):
            parent_a.write({"kemfai_parent_id": child.id})
        with self.assertRaises(ValidationError):
            child.write({"kemfai_parent_id": parent_b.id})

    def test_selection_domain_returns_only_active_posting_accounts_for_company(self):
        posting = self._account(self.company_a, "T019.600")
        self._account(self.company_a, "T019.601", kind="parent")
        self._account(self.company_a, "T019.602", active=False)
        self._account(self.company_b, "T019.600")
        domain = self.Account.kemfai_posting_selection_domain(self.company_a.id)
        selected = self.Account.search(domain)
        self.assertIn(posting, selected)
        self.assertTrue(selected)
        self.assertEqual({self.company_a}, set(selected.mapped("company_id")))
        self.assertEqual({"posting"}, set(selected.mapped("kemfai_node_kind")))
        self.assertEqual({True}, set(selected.mapped("active")))

    def test_two_transactions_same_version_have_one_winner_and_one_stale_result(self):
        fixture_cursor = db_connect(self.env.cr.dbname).cursor()
        try:
            fixture_env = api.Environment(fixture_cursor, self.env.uid, dict(self.env.context))
            account = fixture_env["account.account"].create(
                {
                    "name": "Account T021.700",
                    "name_en": "Account T021.700",
                    "name_ar": "حساب T021.700",
                    "code": "T021.700",
                    "account_type": "asset_current",
                    "company_id": self.company_a.id,
                    "kemfai_node_kind": "posting",
                    "active": True,
                }
            )
            public_id = account.kemfai_public_id
            starting_version = account.version
            fixture_cursor.commit()
        finally:
            fixture_cursor.close()

        barrier = threading.Barrier(2)
        outcomes = []
        failures = []
        lock = threading.Lock()

        def update_in_own_transaction(label):
            connection = db_connect(self.env.cr.dbname)
            cursor = connection.cursor()
            try:
                environment = api.Environment(cursor, self.env.uid, dict(self.env.context))
                model = environment["account.account"]
                barrier.wait(timeout=10)
                try:
                    result = retrying(
                        lambda: model.kemfai_update_account(
                            public_id,
                            str(uuid.uuid4()),
                            f"t021-{label}",
                            starting_version,
                            {"name_en": f"Winner {label}"},
                        ),
                        environment,
                    )
                    cursor.commit()
                    with lock:
                        outcomes.append(result)
                except Exception as error:  # the stale loser is asserted below
                    cursor.rollback()
                    with lock:
                        failures.append(error)
            finally:
                cursor.close()

        threads = [
            threading.Thread(target=update_in_own_transaction, args=(label,), daemon=True)
            for label in ("a", "b")
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

        account.invalidate_recordset()
        with db_connect(self.env.cr.dbname).cursor() as final_cursor:
            final_env = api.Environment(final_cursor, self.env.uid, dict(self.env.context))
            final = final_env["account.account"].with_context(active_test=False).search(
                [("kemfai_public_id", "=", public_id)]
            )
            self.assertEqual(starting_version + 1, final.version)
        self.assertEqual(starting_version + 1, outcomes[0]["version"])
