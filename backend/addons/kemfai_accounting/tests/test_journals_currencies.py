import re
import threading
import uuid

from psycopg2 import IntegrityError

from odoo import api
from odoo.addons.base.models.ir_model import MODULE_UNINSTALL_FLAG
from odoo.exceptions import ValidationError
from odoo.service.model import retrying
from odoo.sql_db import db_connect
from odoo.tests import tagged
from odoo.tests.common import HttpCase


UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


@tagged("post_install", "-at_install", "kemfai_accounting", "story_3")
class TestKemfaiJournals(HttpCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Journal = cls.env["account.journal"]
        cls.company_a = cls.env.company
        cls.company_b = cls.env["res.company"].create(
            {"name": "KEMFAI T106 Company B"}
        )
        cls.actor = "10610610-6111-4111-8111-111111111111"

    def _journal(self, company, code, *, active=True):
        return self.Journal.create(
            {
                "company_id": company.id,
                "code": code,
                "name": f"Journal {code}",
                "name_en": f"Journal {code}",
                "name_ar": f"دفتر {code}",
                "type": "general",
                "active": active,
            }
        )

    def _update(self, journal, expected_version, changes):
        return self.Journal.kemfai_update_journal(
            journal.kemfai_public_id,
            str(uuid.uuid4()),
            self.actor,
            expected_version,
            changes,
            journal.company_id.id,
        )

    def test_rpc_create_list_and_update_are_receipt_bearing_and_replay_safe(self):
        operation_uuid = str(uuid.uuid4())
        values = {
            "company_id": self.company_a.id,
            "code": f"C{uuid.uuid4().hex[:5].upper()}",
            "name_en": "Created through KEMFAI",
            "name_ar": "منشأ عبر كيمفاي",
            "type": "general",
            "active": True,
        }

        created = self.Journal.kemfai_create_journal(
            operation_uuid, self.actor, values
        )
        replay = self.Journal.kemfai_create_journal(
            operation_uuid, self.actor, dict(values, code="IGNORED")
        )
        page = self.Journal.kemfai_list_journals(
            self.company_a.id, {"active": True}
        )

        self.assertEqual(created, replay)
        self.assertTrue(created["audit_event_id"])
        self.assertIn(created["id"], [item["id"] for item in page["items"]])
        self.assertEqual(
            1,
            self.env["kemfai.account.mutation.receipt"].search_count(
                [("operation_uuid", "=", operation_uuid)]
            ),
        )
        self.assertEqual(
            1,
            self.env["kemfai.account.audit.event"].search_count(
                [("operation_uuid", "=", operation_uuid)]
            ),
        )

        updated = self.Journal.kemfai_update_journal(
            created["id"],
            str(uuid.uuid4()),
            self.actor,
            created["version"],
            {"name_en": "Updated through KEMFAI"},
            self.company_a.id,
        )
        self.assertTrue(updated["audit_event_id"])
        self.assertEqual(created["version"] + 1, updated["version"])

    def test_journal_has_immutable_uuid_and_explicit_company_owner(self):
        journal = self._journal(self.company_a, "J6A")
        self.assertRegex(journal.kemfai_public_id, UUID_PATTERN)
        self.assertEqual(self.company_a, journal.company_id)
        with self.assertRaisesRegex(ValidationError, "JOURNAL_PUBLIC_UUID_IMMUTABLE"):
            journal.write({"kemfai_public_id": str(uuid.uuid4())})
        with self.assertRaisesRegex(ValidationError, "JOURNAL_COMPANY_IMMUTABLE"):
            journal.write({"company_id": self.company_b.id})

    def test_code_is_unique_per_company_and_reusable_in_another_company(self):
        first = self._journal(self.company_a, "J6U")
        with self.assertRaises(IntegrityError), self.env.cr.savepoint():
            self._journal(self.company_a, "J6U")
        other = self._journal(self.company_b, "J6U")
        self.assertEqual(first.code, other.code)
        self.assertNotEqual(first.company_id, other.company_id)

    def test_deactivation_advances_version_preserves_history_and_prevents_delete(self):
        journal = self._journal(self.company_a, "J6H")
        starting_version = journal.version

        result = self._update(journal, starting_version, {"active": False})

        self.assertEqual(starting_version + 1, result["version"])
        self.assertFalse(result["active"])
        self.assertFalse(self.Journal.search([("id", "=", journal.id)]))
        historical = self.Journal.with_context(active_test=False).search(
            [("id", "=", journal.id)]
        )
        self.assertEqual(journal, historical)
        self.assertFalse(historical.active)
        with self.assertRaisesRegex(ValidationError, "HISTORY_PROTECTED"):
            historical.unlink()

    def test_odoo_chart_reload_context_can_remove_a_journal(self):
        journal = self._journal(self.company_a, "J6R")

        journal.with_context({MODULE_UNINSTALL_FLAG: True}).unlink()

        self.assertFalse(
            self.Journal.with_context(active_test=False).search(
                [("id", "=", journal.id)]
            )
        )

    def test_stale_version_cannot_overwrite_the_accepted_journal_change(self):
        journal = self._journal(self.company_a, "J6V")
        starting_version = journal.version
        accepted = self._update(
            journal, starting_version, {"name_en": "Accepted journal name"}
        )

        with self.assertRaisesRegex(ValidationError, "STALE_VERSION"):
            self._update(
                journal,
                starting_version,
                {"name_en": "Stale journal name"},
            )

        journal.invalidate_recordset()
        self.assertEqual(starting_version + 1, accepted["version"])
        self.assertEqual("Accepted journal name", journal.name_en)
        self.assertEqual(starting_version + 1, journal.version)

    def test_two_transactions_same_version_have_one_winner_and_one_stale_result(self):
        fixture_cursor = db_connect(self.env.cr.dbname).cursor()
        try:
            fixture_env = api.Environment(
                fixture_cursor, self.env.uid, dict(self.env.context)
            )
            journal = fixture_env["account.journal"].create(
                {
                    "company_id": self.company_a.id,
                    "code": f"R{uuid.uuid4().hex[:4].upper()}",
                    "name": "T106 journal race",
                    "name_en": "T106 journal race",
                    "name_ar": "سباق دفتر T106",
                    "type": "general",
                }
            )
            public_id = journal.kemfai_public_id
            starting_version = journal.version
            fixture_cursor.commit()
        finally:
            fixture_cursor.close()

        barrier = threading.Barrier(2)
        outcomes = []
        failures = []
        lock = threading.Lock()

        def update_in_own_transaction(label):
            cursor = db_connect(self.env.cr.dbname).cursor()
            try:
                environment = api.Environment(
                    cursor, self.env.uid, dict(self.env.context)
                )
                model = environment["account.journal"]
                barrier.wait(timeout=10)
                try:
                    result = retrying(
                        lambda: model.kemfai_update_journal(
                            public_id,
                            str(uuid.uuid4()),
                            f"t106-{label}",
                            starting_version,
                            {"name_en": f"Winner {label}"},
                            self.company_a.id,
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
                target=update_in_own_transaction, args=(label,), daemon=True
            )
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
        self.assertEqual(starting_version + 1, outcomes[0]["version"])

        with db_connect(self.env.cr.dbname).cursor() as final_cursor:
            final_env = api.Environment(
                final_cursor, self.env.uid, dict(self.env.context)
            )
            final = final_env["account.journal"].with_context(
                active_test=False
            ).search([("kemfai_public_id", "=", public_id)])
            self.assertEqual(starting_version + 1, final.version)

@tagged("post_install", "-at_install", "kemfai_accounting", "story_3")
class TestKemfaiCurrencyConfigurations(HttpCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Configuration = cls.env["kemfai.account.currency.config"]
        cls.company_a = cls.env.company
        cls.company_b = cls.env["res.company"].create(
            {"name": "KEMFAI T107 Company B"}
        )
        cls.actor = "10710710-7111-4111-8111-111111111111"
        cls.base_currency = cls.company_a.currency_id
        cls.foreign_currency = cls.env["res.currency"].with_context(
            active_test=False
        ).search([("id", "!=", cls.base_currency.id)], limit=1)
        if not cls.foreign_currency:
            raise AssertionError("T107 requires a second native currency fixture")

    def _put(self, company, currency, if_match, enabled, *, operation_uuid=None):
        return self.Configuration.kemfai_put_currency_configuration(
            company.id,
            currency.name,
            operation_uuid or str(uuid.uuid4()),
            self.actor,
            if_match,
            {"enabled": enabled},
        )

    def _configuration(self, company, currency):
        return self.Configuration.search(
            [
                ("company_id", "=", company.id),
                ("currency_id", "=", currency.id),
            ]
        )

    def test_list_exposes_unconfigured_native_metadata_without_mutating_currency(self):
        native_active = self.foreign_currency.active

        page = self.Configuration.kemfai_list_currency_configurations(
            self.company_a.id, {"enabled": False}
        )

        item = next(
            row
            for row in page["items"]
            if row["currency_code"] == self.foreign_currency.name
        )
        self.assertEqual(self.company_a.kemfai_public_id, item["company_id"])
        self.assertEqual(self.foreign_currency.decimal_places, item["native_decimal_places"])
        self.assertFalse(item["enabled"])
        self.assertFalse(item["is_base"])
        self.assertEqual(1, item["version"])
        self.assertRegex(item["id"], r"^[0-9a-f-]{36}$")
        self.assertFalse(self._configuration(self.company_a, self.foreign_currency))
        self.foreign_currency.invalidate_recordset()
        self.assertEqual(native_active, self.foreign_currency.active)

    def test_put_persists_one_immutable_audit_event_and_receipt(self):
        operation_uuid = str(uuid.uuid4())

        result = self._put(
            self.company_a,
            self.foreign_currency,
            "*",
            True,
            operation_uuid=operation_uuid,
        )

        receipt = self.env["kemfai.account.mutation.receipt"].search(
            [("operation_uuid", "=", operation_uuid)]
        )
        event = self.env["kemfai.account.audit.event"].search(
            [("operation_uuid", "=", operation_uuid)]
        )
        self.assertEqual(1, len(receipt))
        self.assertEqual(1, len(event))
        self.assertEqual("currency.put", receipt.action)
        self.assertEqual(event.public_id, result["audit_event_id"])
        self.assertEqual(result, receipt.result_json)

    def test_enablement_is_company_specific_without_changing_native_activity(self):
        native_active = self.foreign_currency.active

        created = self._put(self.company_a, self.foreign_currency, "*", True)

        configuration = self._configuration(self.company_a, self.foreign_currency)
        self.assertEqual(1, len(configuration))
        self.assertTrue(configuration.enabled)
        self.assertEqual(1, created["version"])
        self.assertEqual(self.company_a, configuration.company_id)
        self.assertFalse(self._configuration(self.company_b, self.foreign_currency))
        self.foreign_currency.invalidate_recordset()
        self.assertEqual(native_active, self.foreign_currency.active)

    def test_native_metadata_and_base_identity_are_read_only(self):
        created = self._put(self.company_a, self.base_currency, "*", True)
        configuration = self._configuration(self.company_a, self.base_currency)

        self.assertEqual(self.base_currency.name, created["currency_code"])
        self.assertEqual(self.base_currency.decimal_places, created["native_decimal_places"])
        self.assertTrue(created["native_metadata_version"])
        self.assertTrue(created["is_base"])
        for changes, code in (
            ({"currency_id": self.foreign_currency.id}, "CURRENCY_IMMUTABLE"),
            ({"company_id": self.company_b.id}, "COMPANY_IMMUTABLE"),
            ({"native_decimal_places": 9}, "NATIVE_METADATA_IMMUTABLE"),
            ({"native_metadata_version": "rewritten"}, "NATIVE_METADATA_IMMUTABLE"),
            ({"is_base": False}, "BASE_CURRENCY_IMMUTABLE"),
        ):
            with self.assertRaisesRegex(ValidationError, code):
                configuration.write(changes)

    def test_create_only_star_rejects_an_existing_configuration(self):
        first = self._put(self.company_a, self.foreign_currency, "*", True)

        with self.assertRaisesRegex(ValidationError, "PRECONDITION_FAILED"):
            self._put(self.company_a, self.foreign_currency, "*", False)

        configuration = self._configuration(self.company_a, self.foreign_currency)
        self.assertTrue(configuration.enabled)
        self.assertEqual(first["version"], configuration.version)

    def test_exact_etag_updates_enablement_once_and_rejects_stale_input(self):
        created = self._put(self.company_a, self.foreign_currency, "*", True)
        current_etag = f'"{created["version"]}"'

        updated = self._put(
            self.company_a, self.foreign_currency, current_etag, False
        )

        self.assertFalse(updated["enabled"])
        self.assertEqual(created["version"] + 1, updated["version"])
        with self.assertRaisesRegex(ValidationError, "PRECONDITION_FAILED"):
            self._put(
                self.company_a, self.foreign_currency, current_etag, True
            )
        configuration = self._configuration(self.company_a, self.foreign_currency)
        self.assertFalse(configuration.enabled)
        self.assertEqual(updated["version"], configuration.version)

    def test_update_only_etag_rejects_an_absent_company_configuration(self):
        with self.assertRaisesRegex(ValidationError, "PRECONDITION_FAILED"):
            self._put(self.company_b, self.foreign_currency, '"1"', True)
        self.assertFalse(self._configuration(self.company_b, self.foreign_currency))

    def test_user_cannot_list_or_mutate_currency_configuration_for_unassigned_company(self):
        restricted_user = self.env["res.users"].with_context(no_reset_password=True).create(
            {
                "name": "KEMFAI restricted currency user",
                "login": f"currency-restricted-{uuid.uuid4()}@example.invalid",
                "company_id": self.company_a.id,
                "company_ids": [(6, 0, [self.company_a.id])],
                "groups_id": [(6, 0, [self.env.ref("base.group_system").id])],
            }
        )
        restricted_configuration = self.Configuration.with_user(restricted_user)
        replay_operation_uuid = str(uuid.uuid4())
        self.env["kemfai.account.mutation.receipt"].kemfai_record_result(
            operation_uuid=replay_operation_uuid,
            action="currency.put",
            actor_identity=self.actor,
            company_id=self.company_a.id,
            audit_event_uuid=str(uuid.uuid4()),
            result={
                "company_id": self.company_a.kemfai_public_id,
                "currency_code": self.foreign_currency.name,
                "enabled": True,
            },
        )

        with self.assertRaisesRegex(ValidationError, "CURRENCY_SCOPE_DENIED"):
            restricted_configuration.kemfai_list_currency_configurations(
                self.company_b.id
            )
        with self.assertRaisesRegex(ValidationError, "CURRENCY_SCOPE_DENIED"):
            restricted_configuration.kemfai_put_currency_configuration(
                self.company_b.id,
                self.foreign_currency.name,
                replay_operation_uuid,
                self.actor,
                "*",
                {"enabled": True},
            )
        with self.assertRaisesRegex(ValidationError, "CURRENCY_SCOPE_DENIED"):
            restricted_configuration.kemfai_put_currency_configuration(
                self.company_b.id,
                self.foreign_currency.name,
                str(uuid.uuid4()),
                self.actor,
                "*",
                {"enabled": True},
            )
        self.assertFalse(self._configuration(self.company_b, self.foreign_currency))

    def test_company_scope_cannot_mutate_another_company_configuration(self):
        created = self._put(self.company_a, self.foreign_currency, "*", True)

        with self.assertRaisesRegex(ValidationError, "PRECONDITION_FAILED"):
            self._put(
                self.company_b,
                self.foreign_currency,
                f'"{created["version"]}"',
                False,
            )

        company_a_configuration = self._configuration(
            self.company_a, self.foreign_currency
        )
        self.assertTrue(company_a_configuration.enabled)
        self.assertFalse(self._configuration(self.company_b, self.foreign_currency))

    def test_two_transactions_create_same_configuration_have_one_winner(self):
        used_currency_ids = self.Configuration.search(
            [("company_id", "=", self.company_a.id)]
        ).mapped("currency_id").ids
        currency = self.env["res.currency"].with_context(active_test=False).search(
            [("id", "not in", used_currency_ids)], limit=1, order="id desc"
        )
        self.assertTrue(currency)
        currency_id = currency.id
        currency_code = currency.name

        barrier = threading.Barrier(2)
        outcomes = []
        failures = []
        lock = threading.Lock()

        def create_in_own_transaction():
            cursor = db_connect(self.env.cr.dbname).cursor()
            try:
                environment = api.Environment(
                    cursor, self.env.uid, dict(self.env.context)
                )
                model = environment["kemfai.account.currency.config"]
                operation_uuid = str(uuid.uuid4())
                barrier.wait(timeout=10)
                try:
                    result = retrying(
                        lambda: model.kemfai_put_currency_configuration(
                            self.company_a.id,
                            currency_code,
                            operation_uuid,
                            "t107-concurrent-create",
                            "*",
                            {"enabled": True},
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
            threading.Thread(target=create_in_own_transaction, daemon=True)
            for _ in range(2)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(1, len(outcomes))
        self.assertEqual(1, len(failures))
        self.assertIn("PRECONDITION_FAILED", str(failures[0]))
        with db_connect(self.env.cr.dbname).cursor() as final_cursor:
            final_env = api.Environment(
                final_cursor, self.env.uid, dict(self.env.context)
            )
            records = final_env["kemfai.account.currency.config"].search(
                [
                    ("company_id", "=", self.company_a.id),
                    ("currency_id", "=", currency_id),
                ]
            )
            self.assertEqual(1, len(records))

    def test_two_transactions_same_etag_have_one_winner(self):
        fixture_cursor = db_connect(self.env.cr.dbname).cursor()
        try:
            fixture_env = api.Environment(
                fixture_cursor, self.env.uid, dict(self.env.context)
            )
            model = fixture_env["kemfai.account.currency.config"]
            created = model.kemfai_put_currency_configuration(
                self.company_a.id,
                self.foreign_currency.name,
                str(uuid.uuid4()),
                self.actor,
                "*",
                {"enabled": True},
            )
            fixture_cursor.commit()
        finally:
            fixture_cursor.close()

        starting_version = created["version"]
        barrier = threading.Barrier(2)
        outcomes = []
        failures = []
        lock = threading.Lock()

        def update_in_own_transaction(label):
            cursor = db_connect(self.env.cr.dbname).cursor()
            try:
                environment = api.Environment(
                    cursor, self.env.uid, dict(self.env.context)
                )
                model = environment["kemfai.account.currency.config"]
                barrier.wait(timeout=10)
                try:
                    result = retrying(
                        lambda: model.kemfai_put_currency_configuration(
                            self.company_a.id,
                            self.foreign_currency.name,
                            str(uuid.uuid4()),
                            f"t107-{label}",
                            f'"{starting_version}"',
                            {"enabled": False},
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
                target=update_in_own_transaction, args=(label,), daemon=True
            )
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
        self.assertIn("PRECONDITION_FAILED", str(failures[0]))
        self.assertEqual(starting_version + 1, outcomes[0]["version"])

        with db_connect(self.env.cr.dbname).cursor() as final_cursor:
            final_env = api.Environment(
                final_cursor, self.env.uid, dict(self.env.context)
            )
            final = final_env["kemfai.account.currency.config"].search(
                [
                    ("company_id", "=", self.company_a.id),
                    ("currency_id", "=", self.foreign_currency.id),
                ]
            )
            self.assertEqual(1, len(final))
            self.assertFalse(final.enabled)
            self.assertEqual(starting_version + 1, final.version)
