import os
import threading
import uuid

from odoo import api
from unittest.mock import patch

from odoo.exceptions import ValidationError
from odoo.service.model import retrying
from odoo.sql_db import db_connect
from odoo.tests import tagged
from odoo.tests.common import HttpCase


@tagged("post_install", "-at_install", "kemfai_accounting", "story_1")
class TestAccountingAuditReceipts(HttpCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Account = cls.env["account.account"].with_context(tracking_disable=True)
        cls.Receipt = cls.env["kemfai.account.mutation.receipt"]
        cls.Event = cls.env["kemfai.account.audit.event"]
        cls.company = cls.env.company
        cls.actor = "20202020-1111-4111-8111-111111111111"

    def _operation(self):
        return str(uuid.uuid4())

    def _create(self, operation_uuid=None, code=None):
        operation_uuid = operation_uuid or self._operation()
        code = code or f"T020.{uuid.uuid4().hex[:8]}"
        result = self.Account.kemfai_create_account(
            operation_uuid,
            self.actor,
            {
                "company_id": self.company.id,
                "code": code,
                "name_en": f"Account {code}",
                "name_ar": f"حساب {code}",
                "account_type": "asset_current",
                "kemfai_node_kind": "posting",
            },
        )
        return operation_uuid, result

    def _receipt(self, operation_uuid):
        return self.Receipt.search([("operation_uuid", "=", operation_uuid)])

    def _event(self, operation_uuid):
        return self.Event.search([("operation_uuid", "=", operation_uuid)])

    def test_create_writes_one_immutable_receipt_and_audit_event_with_version_one(self):
        operation_uuid, result = self._create()
        account = self.Account.search([("kemfai_public_id", "=", result["id"])])
        self.assertTrue(account)
        self.assertEqual(result["version"], 1)
        self.assertEqual(account.version, 1)
        receipt = self._receipt(operation_uuid)
        event = self._event(operation_uuid)
        self.assertEqual(len(receipt), 1)
        self.assertEqual(len(event), 1)
        self.assertEqual(receipt.audit_event_uuid, event.public_id)
        self.assertEqual(event.target_public_id, account.kemfai_public_id)
        self.assertEqual(event.action, "account.create")
        with self.assertRaises(ValidationError):
            receipt.write({"result_json": "{}"})
        with self.assertRaises(ValidationError):
            event.unlink()

    def test_update_advances_version_once_and_stale_update_writes_no_history(self):
        _, created = self._create()
        update_operation = self._operation()
        updated = self.Account.kemfai_update_account(
            created["id"],
            update_operation,
            self.actor,
            created["version"],
            {"name_en": "Updated name", "name_ar": "اسم محدث"},
        )
        self.assertEqual(updated["version"], created["version"] + 1)
        before_receipts = self.Receipt.search_count([])
        before_events = self.Event.search_count([])
        with self.assertRaisesRegex(ValidationError, "STALE_VERSION"):
            self.Account.kemfai_update_account(
                created["id"],
                self._operation(),
                self.actor,
                created["version"],
                {"name_en": "Must not persist"},
            )
        self.assertEqual(self.Receipt.search_count([]), before_receipts)
        self.assertEqual(self.Event.search_count([]), before_events)

    def test_deactivate_preserves_history_and_referenced_account_cannot_unlink(self):
        _, created = self._create()
        deactivated = self.Account.kemfai_deactivate_account(
            created["id"], self._operation(), self.actor, created["version"]
        )
        account = self.Account.with_context(active_test=False).search(
            [("kemfai_public_id", "=", created["id"])]
        )
        self.assertTrue(account.exists())
        self.assertFalse(account.active)
        self.assertEqual(deactivated["version"], created["version"] + 1)
        with self.assertRaisesRegex(ValidationError, "HISTORY_PROTECTED"):
            account.with_context(active_test=False).unlink()

    def test_same_operation_uuid_replays_original_result_without_duplicate_mutation(self):
        operation_uuid, first = self._create()
        second = self.Account.kemfai_create_account(
            operation_uuid,
            self.actor,
            {
                "company_id": self.company.id,
                "code": "DIFFERENT.RETRY-PAYLOAD",
                "name_en": "Different",
                "name_ar": "مختلف",
                "account_type": "expense",
                "kemfai_node_kind": "posting",
            },
        )
        self.assertEqual(first, second)
        self.assertEqual(len(self._receipt(operation_uuid)), 1)
        self.assertEqual(len(self._event(operation_uuid)), 1)
        self.assertEqual(
            self.Account.search_count([("kemfai_public_id", "=", first["id"])]), 1
        )

    def test_receipt_failure_rolls_back_account_and_audit_and_returns_no_success(self):
        operation_uuid = self._operation()
        before_accounts = self.Account.search_count([])
        before_events = self.Event.search_count([])
        with patch.object(type(self.Receipt), "create", side_effect=ValidationError("receipt down")):
            with self.assertRaisesRegex(ValidationError, "receipt down"):
                with self.env.cr.savepoint():
                    self._create(operation_uuid=operation_uuid)
        self.assertEqual(self.Account.search_count([]), before_accounts)
        self.assertEqual(self.Event.search_count([]), before_events)
        self.assertFalse(self._receipt(operation_uuid))

    def test_audit_failure_rolls_back_account_and_receipt_and_returns_no_success(self):
        operation_uuid = self._operation()
        before_accounts = self.Account.search_count([])
        before_receipts = self.Receipt.search_count([])
        with patch.object(type(self.Event), "create", side_effect=ValidationError("audit down")):
            with self.assertRaisesRegex(ValidationError, "audit down"):
                with self.env.cr.savepoint():
                    self._create(operation_uuid=operation_uuid)
        self.assertEqual(self.Account.search_count([]), before_accounts)
        self.assertEqual(self.Receipt.search_count([]), before_receipts)
        self.assertFalse(self._event(operation_uuid))

    def test_two_transactions_same_idempotency_key_return_one_identical_result(self):
        operation_uuid = self._operation()
        code = f"T022.{uuid.uuid4().hex[:8]}"
        payload = {
            "company_id": self.company.id,
            "code": code,
            "name_en": f"Account {code}",
            "name_ar": f"حساب {code}",
            "account_type": "asset_current",
            "kemfai_node_kind": "posting",
        }

        barrier = threading.Barrier(2)
        results = []
        errors = []
        lock = threading.Lock()

        def create_in_own_transaction(label):
            cursor = db_connect(self.env.cr.dbname).cursor()
            try:
                environment = api.Environment(cursor, self.env.uid, dict(self.env.context))
                model = environment["account.account"]
                barrier.wait(timeout=10)
                try:
                    result = retrying(
                        lambda: model.kemfai_create_account(
                            operation_uuid, f"t022-{label}", dict(payload)
                        ),
                        environment,
                    )
                    cursor.commit()
                    with lock:
                        results.append(result)
                except Exception as error:  # surfaced in the main test thread
                    cursor.rollback()
                    with lock:
                        errors.append(error)
            finally:
                cursor.close()

        threads = [
            threading.Thread(target=create_in_own_transaction, args=(label,), daemon=True)
            for label in ("a", "b")
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual([], errors)
        self.assertEqual(2, len(results))
        self.assertEqual(results[0], results[1])

        self.env.invalidate_all()
        with db_connect(self.env.cr.dbname).cursor() as final_cursor:
            final_env = api.Environment(final_cursor, self.env.uid, dict(self.env.context))
            self.assertEqual(
                1,
                final_env["kemfai.account.mutation.receipt"].search_count(
                    [("operation_uuid", "=", operation_uuid)]
                ),
            )
            self.assertEqual(
                1,
                final_env["kemfai.account.audit.event"].search_count(
                    [("operation_uuid", "=", operation_uuid)]
                ),
            )
            self.assertEqual(
                1,
                final_env["account.account"].search_count(
                    [("kemfai_public_id", "=", results[0]["id"]), ("code", "=", code)]
                ),
            )


@tagged("post_install", "-at_install", "kemfai_accounting", "story_2")
class TestDimensionMutationAuditReceipts(HttpCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Definition = cls.env["kemfai.dimension.definition"]
        cls.Receipt = cls.env["kemfai.account.mutation.receipt"]
        cls.Event = cls.env["kemfai.account.audit.event"]
        cls.company = cls.env.company
        cls.actor = "75757575-1111-4111-8111-111111111111"

    def test_audit_failure_rolls_back_dimension_and_receipt(self):
        operation_uuid = str(uuid.uuid4())
        key = f"t092_audit_{uuid.uuid4().hex[:8]}"
        before_definitions = self.Definition.search_count([])
        before_receipts = self.Receipt.search_count([])

        with patch.object(type(self.Event), "create", side_effect=ValidationError("audit down")):
            with self.assertRaisesRegex(ValidationError, "audit down"):
                with self.env.cr.savepoint():
                    self.Definition.kemfai_create_dimension_definition(
                        operation_uuid,
                        self.actor,
                        {
                            "company_id": self.company.id,
                            "key": key,
                            "kind": "custom",
                            "name_en": "Audit rollback dimension",
                            "name_ar": "بُعد تراجع التدقيق",
                        },
                    )

        self.assertEqual(before_definitions, self.Definition.search_count([]))
        self.assertEqual(before_receipts, self.Receipt.search_count([]))
        self.assertFalse(self.Receipt.search([("operation_uuid", "=", operation_uuid)]))
        self.assertFalse(self.Event.search([("operation_uuid", "=", operation_uuid)]))

    def test_enabled_live_fault_parameter_rolls_back_dimension_and_receipt(self):
        operation_uuid = str(uuid.uuid4())
        key = f"t104_live_fault_{uuid.uuid4().hex[:8]}"
        before_definitions = self.Definition.search_count([])
        before_receipts = self.Receipt.search_count([])
        parameter = self.env["ir.config_parameter"].sudo()
        parameter.set_param("kemfai.accounting.test_fault_mode", "tenant-audit-create-failure")
        self.addCleanup(
            parameter.set_param, "kemfai.accounting.test_fault_mode", False
        )

        with patch.dict(os.environ, {"KEMFAI_ACCOUNTING_TEST_FAULTS": "1"}):
            with self.assertRaisesRegex(ValidationError, "ACCOUNT_AUDIT_TEST_FAULT"):
                with self.env.cr.savepoint():
                    self.Definition.kemfai_create_dimension_definition(
                        operation_uuid,
                        self.actor,
                        {
                            "company_id": self.company.id,
                            "key": key,
                            "kind": "custom",
                            "name_en": "Live fault rollback dimension",
                            "name_ar": "بُعد تراجع عطل مباشر",
                        },
                    )

        self.assertEqual(before_definitions, self.Definition.search_count([]))
        self.assertEqual(before_receipts, self.Receipt.search_count([]))
        self.assertFalse(self.Receipt.search([("operation_uuid", "=", operation_uuid)]))
        self.assertFalse(self.Event.search([("operation_uuid", "=", operation_uuid)]))

    def test_two_transactions_same_idempotency_key_create_one_dimension_and_replay(self):
        operation_uuid = str(uuid.uuid4())
        key = f"t075_{uuid.uuid4().hex[:8]}"
        payload = {
            "company_id": self.company.id,
            "key": key,
            "kind": "custom",
            "name_en": "T075 concurrent dimension",
            "name_ar": "بُعد متزامن T075",
        }
        barrier = threading.Barrier(2)
        results = []
        errors = []
        lock = threading.Lock()

        def create_in_own_transaction():
            cursor = db_connect(self.env.cr.dbname).cursor()
            try:
                environment = api.Environment(
                    cursor, self.env.uid, dict(self.env.context)
                )
                model = environment["kemfai.dimension.definition"]
                barrier.wait(timeout=10)
                try:
                    result = retrying(
                        lambda: model.kemfai_create_dimension_definition(
                            operation_uuid, self.actor, dict(payload)
                        ),
                        environment,
                    )
                    cursor.commit()
                    with lock:
                        results.append(result)
                except Exception as error:  # surfaced in the main test thread
                    cursor.rollback()
                    with lock:
                        errors.append(error)
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
        self.assertEqual([], errors)
        self.assertEqual(2, len(results))
        self.assertEqual(results[0], results[1])

        with db_connect(self.env.cr.dbname).cursor() as final_cursor:
            final_env = api.Environment(
                final_cursor, self.env.uid, dict(self.env.context)
            )
            definitions = final_env["kemfai.dimension.definition"].search(
                [("company_id", "=", self.company.id), ("key", "=", key)]
            )
            receipts = final_env["kemfai.account.mutation.receipt"].search(
                [("operation_uuid", "=", operation_uuid)]
            )
            events = final_env["kemfai.account.audit.event"].search(
                [("operation_uuid", "=", operation_uuid)]
            )
            self.assertEqual(1, len(definitions))
            self.assertEqual(1, len(receipts))
            self.assertEqual(1, len(events))
            self.assertEqual(definitions.public_id, results[0]["id"])
            self.assertEqual(receipts.audit_event_uuid, events.public_id)
            self.assertEqual(definitions.public_id, events.target_public_id)


@tagged("post_install", "-at_install", "kemfai_accounting", "story_3", "no_ledger")
class TestDraftValidationAuditReceipts(HttpCase):
    """T110: prove a same-key validation race has one durable outcome."""

    def test_two_transactions_same_validation_key_create_one_run_and_one_replay(self):
        operation_uuid = str(uuid.uuid4())
        actor = "11011011-0111-4111-8111-111111111111"
        database = self.env.cr.dbname
        context = dict(self.env.context)

        setup_cursor = db_connect(database).cursor()
        try:
            setup_env = api.Environment(setup_cursor, self.env.uid, context)
            company = setup_env["res.company"].create(
                {"name": f"KEMFAI T110 Company {uuid.uuid4().hex[:8]}"}
            )
            company_id = company.id
            account = setup_env["account.account"].with_context(
                tracking_disable=True
            ).create(
                {
                    "name": "T110 Validation Race",
                    "name_en": "T110 Validation Race",
                    "name_ar": "سباق تحقق T110",
                    "code": f"T110.{uuid.uuid4().hex[:8]}",
                    "account_type": "asset_current",
                    "company_id": company.id,
                    "kemfai_node_kind": "posting",
                }
            )
            journal = setup_env["account.journal"].create(
                {
                    "company_id": company.id,
                    "code": f"R{uuid.uuid4().hex[:4].upper()}",
                    "name": "T110 Validation Race",
                    "type": "general",
                }
            )
            currency = company.currency_id
            configuration = setup_env[
                "kemfai.account.currency.config"
            ].kemfai_put_currency_configuration(
                company.id,
                currency.name,
                str(uuid.uuid4()),
                actor,
                "*",
                {"enabled": True},
            )
            line_id = str(uuid.uuid4())
            saved = setup_env["kemfai.account.draft"].kemfai_save_minimal_draft(
                str(uuid.uuid4()),
                actor,
                company.id,
                {
                    "journalId": journal.kemfai_public_id,
                    "accountingDate": "2026-11-07",
                    "description": "T110 concurrent validation",
                    "transactionType": "manual_journal",
                    "source": {
                        "type": "manual_evidence",
                        "id": str(uuid.uuid4()),
                    },
                    "lines": [
                        {
                            "id": line_id,
                            "sequence": 1,
                            "accountId": account.kemfai_public_id,
                            "description": "T110 exact line",
                            "transactionCurrencyCode": currency.name,
                            "transactionPrecision": currency.decimal_places,
                            "transactionCurrencyMetadataVersion": configuration[
                                "native_metadata_version"
                            ],
                            "companyBaseCurrencyCode": currency.name,
                            "basePrecision": currency.decimal_places,
                            "baseCurrencyMetadataVersion": configuration[
                                "native_metadata_version"
                            ],
                            "currencyConfigurationVersion": configuration["version"],
                            "transactionDebit": "7.5000",
                            "transactionCredit": "7.5000",
                            "baseDebit": "7.5000",
                            "baseCredit": "7.5000",
                            "rateReference": None,
                            "rateEffectiveDate": None,
                            "dimensions": [],
                        }
                    ],
                },
            )
            setup_cursor.commit()
        finally:
            setup_cursor.close()

        barrier = threading.Barrier(2)
        results = []
        errors = []
        lock = threading.Lock()

        def validate_in_own_transaction():
            cursor = db_connect(database).cursor()
            try:
                environment = api.Environment(cursor, self.env.uid, context)
                draft_model = environment["kemfai.account.draft"]
                barrier.wait(timeout=10)
                try:
                    result = retrying(
                        lambda: draft_model.kemfai_validate_minimal_draft(
                            operation_uuid,
                            actor,
                            saved["id"],
                            saved["version"],
                            company_id,
                        ),
                        environment,
                    )
                    cursor.commit()
                    with lock:
                        results.append(result)
                except Exception as error:  # surfaced in the main test thread
                    cursor.rollback()
                    with lock:
                        errors.append(error)
            finally:
                cursor.close()

        threads = [
            threading.Thread(target=validate_in_own_transaction, daemon=True)
            for _ in range(2)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual([], errors)
        self.assertEqual(2, len(results))
        self.assertEqual(results[0], results[1])
        self.assertEqual("none", results[0]["ledger_effect"])

        with db_connect(database).cursor() as final_cursor:
            final_env = api.Environment(final_cursor, self.env.uid, context)
            draft = final_env["kemfai.account.draft"].search(
                [("public_id", "=", saved["id"])], limit=1
            )
            runs = final_env["kemfai.account.draft.validation"].search(
                [("draft_id", "=", draft.id)]
            )
            receipts = final_env["kemfai.account.mutation.receipt"].search(
                [("operation_uuid", "=", operation_uuid)]
            )
            events = final_env["kemfai.account.audit.event"].search(
                [("operation_uuid", "=", operation_uuid)]
            )
            self.assertEqual(1, len(runs))
            self.assertEqual(1, len(receipts))
            self.assertEqual(1, len(events))
            self.assertEqual(runs.public_id, results[0]["validation_run_id"])
            self.assertEqual(receipts.audit_event_uuid, events.public_id)
            self.assertEqual(draft.public_id, events.target_public_id)
            with self.assertRaisesRegex(ValidationError, "IMMUTABLE"):
                runs.write({"status": "invalid"})
            with self.assertRaisesRegex(ValidationError, "IMMUTABLE"):
                runs.unlink()
