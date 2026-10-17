import threading
import time

from odoo import api
from odoo.exceptions import ValidationError
from odoo.service.model import retrying
from odoo.sql_db import db_connect
from odoo.tests import tagged
from odoo.tests.common import HttpCase, TransactionCase


@tagged('post_install', '-at_install', 'kemfai_module_selection')
class TestModuleSelection(TransactionCase):
    TENANT = '07500000-0000-4000-8000-000000000001'
    ACCOUNT = '07500000-0000-4000-8000-000000000002'
    ACTOR = '07500000-0000-4000-8000-000000000003'

    def replace(
        self, keys, operation='07500000-0000-4000-8000-000000000004',
        occurred_at='2026-10-17T08:00:00.123Z'
    ):
        return self.env['kemfai.module.selection'].kemfai_replace_selection(
            keys, operation, self.TENANT, self.ACCOUNT, self.ACTOR, occurred_at
        )

    def test_replace_is_complete_deduplicated_and_immediately_readable(self):
        selection = self.env['kemfai.module.selection']

        first = self.replace(['module.sales', 'module.accounting', 'module.sales'])
        self.assertEqual(first['featureKeys'], ['module.accounting', 'module.sales'])
        self.assertEqual(first['added'], ['module.accounting', 'module.sales'])
        self.assertEqual(
            selection.kemfai_get_selection(),
            ['module.accounting', 'module.sales'],
        )

        self.assertTrue(selection.kemfai_ack_selection_event(
            first['operationUuid'], self.TENANT, self.ACCOUNT, self.ACTOR
        ))
        second = self.replace(
            ['module.inventory'], '07500000-0000-4000-8000-000000000005'
        )
        self.assertEqual(second['removed'], ['module.accounting', 'module.sales'])
        self.assertEqual(selection.kemfai_get_selection(), ['module.inventory'])
        self.assertFalse(selection.search([('feature_key', '=', 'module.sales')]).enabled)

    def test_unacknowledged_retry_returns_original_truthful_delta(self):
        selection = self.env['kemfai.module.selection']
        first = self.replace(['module.accounting'])
        retry = self.replace(
            ['module.accounting'], '07500000-0000-4000-8000-000000000006'
        )

        self.assertEqual(retry, first)
        self.assertEqual(retry['added'], ['module.accounting'])
        self.assertEqual(selection.kemfai_get_selection(), ['module.accounting'])

    def test_pending_a_is_a_barrier_to_b_and_context_mismatch_cannot_ack(self):
        selection = self.env['kemfai.module.selection']
        first = self.replace(['module.accounting'])
        blocked = self.replace(
            ['module.inventory'], '07500000-0000-4000-8000-000000000006'
        )

        self.assertEqual(blocked['operationUuid'], first['operationUuid'])
        self.assertEqual(selection.kemfai_get_selection(), ['module.accounting'])
        with self.assertRaises(ValidationError):
            selection.kemfai_ack_selection_event(
                first['operationUuid'], self.TENANT,
                '07500000-0000-4000-8000-000000000099', self.ACTOR
            )
        self.assertFalse(
            self.env['kemfai.module.selection.event'].search(
                [('operation_uuid', '=', first['operationUuid'])]
            ).audited
        )

    def test_invalid_payload_fails_before_mutating_cache(self):
        selection = self.env['kemfai.module.selection']
        self.replace(['module.accounting'])

        with self.assertRaises(ValidationError):
            self.replace(['module.sales', ''])

        self.assertEqual(selection.kemfai_get_selection(), ['module.accounting'])

    def test_occurred_at_accepts_production_z_and_offset_and_preserves_instant(self):
        selection = self.env['kemfai.module.selection']
        first = self.replace(['module.accounting'])
        self.assertEqual(first['occurredAt'], '2026-10-17T08:00:00.123Z')
        event = self.env['kemfai.module.selection.event'].search([
            ('operation_uuid', '=', first['operationUuid'])
        ])
        self.assertEqual(str(event.occurred_at), '2026-10-17 08:00:00.123000')
        selection.kemfai_ack_selection_event(
            first['operationUuid'], self.TENANT, self.ACCOUNT, self.ACTOR
        )

        offset = self.replace(
            ['module.inventory'], '07500000-0000-4000-8000-000000000007',
            '2026-10-17T10:00:00.123+02:00'
        )
        self.assertEqual(offset['occurredAt'], '2026-10-17T08:00:00.123Z')

    def test_occurred_at_rejects_invalid_or_timezone_ambiguous_values(self):
        selection = self.env['kemfai.module.selection']
        for value in (
            '2026-10-17 08:00:00',
            '2026-10-17T08:00:00',
            'not-a-time',
            '',
            None,
        ):
            with self.assertRaises(ValidationError):
                self.replace(['module.accounting'], occurred_at=value)
        self.assertEqual(selection.kemfai_get_selection(), [])


@tagged('post_install', '-at_install', 'kemfai_module_selection')
class TestModuleSelectionConcurrency(HttpCase):
    """Two real cursors force a stale repeatable-read waiter through Odoo retrying."""

    TENANT = '07500000-0000-4000-8000-000000000011'
    ACCOUNT = '07500000-0000-4000-8000-000000000012'
    ACTOR = '07500000-0000-4000-8000-000000000013'
    OPERATION = '07500000-0000-4000-8000-000000000014'

    def setUp(self):
        super().setUp()
        self._test_dbname = self.env.cr.dbname
        self._test_uid = self.env.uid
        self.addCleanup(self._clear_selection_state)
        self._clear_selection_state()

    def _clear_selection_state(self):
        """Commit fixture changes without touching HttpCase's managed cursor."""
        cr = db_connect(self._test_dbname).cursor()
        try:
            env = api.Environment(cr, self._test_uid, {})
            env['kemfai.module.selection.event'].search([]).unlink()
            env['kemfai.module.selection'].search([]).unlink()
            cr.commit()
        finally:
            cr.close()

    def test_stale_waiter_retries_and_returns_the_single_pending_receipt(self):
        locked = threading.Event()
        release = threading.Event()
        waiter_started = threading.Event()
        results = {}
        errors = {}
        uid = self.env.uid
        dbname = self.env.cr.dbname

        def replace(env, operation, keys):
            return env['kemfai.module.selection'].kemfai_replace_selection(
                keys, operation, self.TENANT, self.ACCOUNT, self.ACTOR,
                '2026-10-17T08:00:00.123Z'
            )

        def first_writer():
            cr = db_connect(dbname).cursor()
            try:
                env = api.Environment(cr, uid, {})
                # Hold the exact singleton row before entering the method. Its own UPDATE
                # is re-entrant on this cursor; the waiter below must block on that UPDATE.
                cr.execute(
                    'UPDATE kemfai_module_selection_lock '
                    'SET generation = generation + 1 WHERE singleton_key = true'
                )
                locked.set()
                if not release.wait(timeout=5):
                    raise AssertionError('test did not release the first writer')
                results['first'] = retrying(
                    lambda: replace(env, self.OPERATION, ['module.accounting']), env
                )
            except Exception as exc:  # pragma: no cover - surfaced in the main thread
                errors['first'] = exc
            finally:
                cr.close()

        def stale_waiter():
            if not locked.wait(timeout=5):
                errors['waiter'] = AssertionError('first writer never acquired the mutex')
                return
            cr = db_connect(dbname).cursor()
            try:
                cr.execute("SET application_name = 'kemfai_module_selection_stale_waiter'")
                env = api.Environment(cr, uid, {})
                waiter_started.set()
                results['waiter'] = retrying(
                    lambda: replace(
                        env,
                        '07500000-0000-4000-8000-000000000015',
                        ['module.inventory'],
                    ),
                    env,
                )
            except Exception as exc:  # pragma: no cover - surfaced in the main thread
                errors['waiter'] = exc
            finally:
                cr.close()

        first = threading.Thread(target=first_writer)
        waiter = threading.Thread(target=stale_waiter)
        first.start()
        waiter.start()
        observer_cr = None
        waiter_is_blocked = False
        try:
            self.assertTrue(waiter_started.wait(timeout=5), 'waiter did not start')
            observer_cr = db_connect(dbname).cursor()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                observer_cr.execute('SELECT pg_stat_clear_snapshot()')
                observer_cr.execute(
                    "SELECT wait_event_type FROM pg_stat_activity "
                    "WHERE application_name = 'kemfai_module_selection_stale_waiter'"
                )
                row = observer_cr.fetchone()
                if row and row[0] == 'Lock':
                    waiter_is_blocked = True
                    break
                time.sleep(0.05)
        finally:
            if observer_cr is not None:
                observer_cr.close()
            release.set()
            first.join(timeout=15)
            waiter.join(timeout=15)

        self.assertTrue(waiter_is_blocked, 'waiter never contended on the replacement mutex')
        self.assertFalse(first.is_alive(), 'first writer hung')
        self.assertFalse(waiter.is_alive(), 'stale waiter hung')
        self.assertEqual(errors, {}, f'concurrent replacements raised: {errors}')
        self.assertEqual(results['first']['operationUuid'], self.OPERATION)
        self.assertEqual(results['waiter'], results['first'])

        read_cr = db_connect(dbname).cursor()
        try:
            read_env = api.Environment(read_cr, uid, {})
            events = read_env['kemfai.module.selection.event'].search(
                [('audited', '=', False)]
            )
            self.assertEqual(len(events), 1)
            self.assertEqual(events.operation_uuid, self.OPERATION)
            self.assertEqual(
                read_env['kemfai.module.selection'].kemfai_get_selection(),
                ['module.accounting'],
            )
        finally:
            read_cr.close()
