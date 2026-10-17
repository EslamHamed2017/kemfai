from odoo.exceptions import ValidationError
from odoo.tests import tagged
from odoo.tests.common import TransactionCase


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
