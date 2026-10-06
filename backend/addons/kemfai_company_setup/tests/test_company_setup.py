"""Real-Odoo-registry tests for the T054 GET/PUT /companies/current/setup RPC
surface implemented on res.company in ../models/company.py.

Runs only against a live Odoo 18 + PostgreSQL registry (scratch database),
driven by scripts/test_t054_live.sh — never mocked. Covers:
  * every step's persistence and resume-at-first-incomplete-step (Acceptance
    Scenario 3.3/3.4),
  * required-field failures (Acceptance Scenario 3.6),
  * country change with an existing VAT value, both for a country that has a
    configured rule (valid re-validation) and one that does not (config-gap
    409 source, Edge Case "must not silently accept unvalidated data"),
  * two genuinely parallel transactions saving the same company/version:
    both commit, versions are distinct and monotonic, exactly one reports
    stale, and final field values reflect lock-acquisition order (arbiter
    resolution point 5).
"""
import threading

from odoo import api
from odoo.exceptions import ValidationError
from odoo.service.model import retrying
from odoo.sql_db import db_connect
from odoo.tests.common import HttpCase, TransactionCase
from odoo.tests import tagged


@tagged('post_install', '-at_install', 'kemfai_company_setup')
class TestCompanySetupWizard(TransactionCase):
    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].search([], limit=1)
        self.assertTrue(self.company, 'tenant_core must seed exactly one company')
        self.ae = self.env['res.country'].search([('code', '=', 'AE')], limit=1)
        self.us = self.env['res.country'].search([('code', '=', 'US')], limit=1)
        self.sa = self.env['res.country'].search([('code', '=', 'SA')], limit=1)
        self.assertTrue(self.ae and self.us and self.sa, 'base res.country data must be loaded')
        self.env['kemfai.company.setup.country.rule'].sudo().create({
            'country_id': self.ae.id,
            'vat_regex': r'\d{15}',
            'vat_format_hint': '1' * 15,
        })
        # SA has its own configured rule, compatible with the same 15-digit VAT value
        # as AE's — used by the genuine different-country/existing-VAT-still-valid case.
        self.env['kemfai.company.setup.country.rule'].sudo().create({
            'country_id': self.sa.id,
            'vat_regex': r'\d{15}',
            'vat_format_hint': '3' * 15,
        })
        # US deliberately has no configured rule (missing-rule config-gap case).

    def _any_industry_id(self):
        industry = self.env['res.partner.industry'].search([], limit=1)
        if not industry:
            industry = self.env['res.partner.industry'].create({'name': 'KEMFAI Test Industry'})
        return industry.id

    # -- GET: resume at first incomplete step, persistence -----------------

    def test_fresh_company_resumes_at_country_step(self):
        state = self.company.kemfai_setup_get_state()
        self.assertEqual(state['currentStep'], 'country')
        self.assertFalse(state['setupComplete'])
        self.assertEqual(state['version'], 0)
        self.assertFalse(state['stale'])

    def test_each_step_persists_and_resume_advances_in_fixed_order(self):
        steps = [
            ('country', {'country': 'AE'}),
            ('identity', {'legal_name': 'Acme FZ', 'trade_name': 'Acme'}),
            ('currency', {'base_currency': 'AED'}),
            ('fiscal_year', {'fiscal_year_start_month': '1', 'fiscal_year_start_day': 1}),
            ('vat_tax', {'vat_tax_registration': '1' * 15}),
            ('industry', {'industry': self._any_industry_id()}),
            ('accounting_setup', {'accounting_setup_template': 'standard'}),
        ]
        expected_next = ['identity', 'currency', 'fiscal_year', 'vat_tax', 'industry',
                          'accounting_setup', 'accounting_setup']
        for (step, values), next_step in zip(steps, expected_next):
            result = self.company.kemfai_setup_save_step(step, values, None)
            self.assertEqual(result['currentStep'], next_step)
            self.assertFalse(result['stale'])

        # Resume: a fresh GET reflects every persisted value, in order.
        state = self.company.kemfai_setup_get_state()
        self.assertEqual(state['currentStep'], 'accounting_setup')
        self.assertEqual(state['values']['country'], 'AE')
        self.assertEqual(state['values']['legal_name'], 'Acme FZ')
        self.assertEqual(state['values']['base_currency'], 'AED')
        self.assertEqual(state['values']['vat_tax_registration'], '1' * 15)
        self.assertEqual(state['version'], len(steps))

    def test_version_advances_by_exactly_one_per_save(self):
        v0 = self.company.kemfai_setup_get_state()['version']
        r1 = self.company.kemfai_setup_save_step('country', {'country': 'AE'}, v0)
        self.assertEqual(r1['version'], v0 + 1)
        r2 = self.company.kemfai_setup_save_step(
            'identity', {'legal_name': 'X', 'trade_name': 'Y'}, r1['version']
        )
        self.assertEqual(r2['version'], v0 + 2)
        self.assertFalse(r1['stale'])
        self.assertFalse(r2['stale'])

    def test_matching_base_version_is_not_stale(self):
        v0 = self.company.kemfai_setup_get_state()['version']
        result = self.company.kemfai_setup_save_step('country', {'country': 'AE'}, v0)
        self.assertFalse(result['stale'])

    def test_mismatched_base_version_is_stale_but_still_commits(self):
        v0 = self.company.kemfai_setup_get_state()['version']
        result = self.company.kemfai_setup_save_step('country', {'country': 'AE'}, v0 + 99)
        self.assertTrue(result['stale'])
        self.assertEqual(result['version'], v0 + 1)
        self.assertEqual(self.company.country.code, 'AE')

    # -- Required-field failures (Acceptance Scenario 3.6) ------------------

    def test_blank_required_field_is_rejected(self):
        with self.assertRaisesRegex(ValidationError, 'KEMFAI_REQUIRED_FIELD'):
            self.company.kemfai_setup_save_step(
                'identity', {'legal_name': '', 'trade_name': 'Acme'}, None
            )

    def test_unknown_step_is_rejected(self):
        with self.assertRaisesRegex(ValidationError, 'KEMFAI_UNKNOWN_STEP'):
            self.company.kemfai_setup_save_step('not_a_step', {'x': 1}, None)

    def test_unknown_country_code_is_rejected(self):
        with self.assertRaisesRegex(ValidationError, 'KEMFAI_INVALID_COUNTRY'):
            self.company.kemfai_setup_save_step('country', {'country': 'ZZ'}, None)

    # -- Country change with an existing VAT value ---------------------------

    def test_country_change_to_ruled_country_revalidates_existing_vat(self):
        v1 = self.company.kemfai_setup_save_step('country', {'country': 'AE'}, None)
        v2 = self.company.kemfai_setup_save_step(
            'vat_tax', {'vat_tax_registration': '1' * 15}, None
        )
        self.assertEqual(v2['version'], v1['version'] + 1)
        # Genuine country change AE -> SA with the existing, already-persisted VAT
        # value. SA has its own configured rule (also \d{15}), so the 15-digit
        # value saved under AE must re-validate and persist under SA without being
        # rejected or silently dropped.
        result = self.company.kemfai_setup_save_step('country', {'country': 'SA'}, None)
        self.assertEqual(result['version'], v2['version'] + 1)
        self.assertFalse(result['stale'])
        self.assertEqual(result['values']['country'], 'SA')
        self.assertEqual(result['values']['vat_tax_registration'], '1' * 15)
        self.assertEqual(self.company.country.code, 'SA')

        # Resume via a fresh GET confirms the SA country and the revalidated VAT
        # are both durably persisted, not just returned by the save call.
        state = self.company.kemfai_setup_get_state()
        self.assertEqual(state['values']['country'], 'SA')
        self.assertEqual(state['values']['vat_tax_registration'], '1' * 15)
        self.assertEqual(state['version'], result['version'])

    def test_country_change_to_missing_rule_country_blocks_with_config_gap(self):
        self.company.kemfai_setup_save_step('country', {'country': 'AE'}, None)
        self.company.kemfai_setup_save_step(
            'vat_tax', {'vat_tax_registration': '1' * 15}, None
        )
        with self.assertRaisesRegex(ValidationError, 'KEMFAI_CONFIG_GAP'):
            # US has no configured VAT rule; the existing AE-valid VAT value must
            # not be silently accepted against it. Wrapped in a savepoint to
            # mirror the real JSON-RPC dispatcher, which rolls back the whole
            # call's transaction on any raised exception (never a partial write).
            with self.env.cr.savepoint():
                self.company.kemfai_setup_save_step('country', {'country': 'US'}, None)
        self.company.invalidate_recordset()
        self.assertEqual(self.company.country.code, 'AE')

    def test_country_change_with_malformed_existing_vat_is_blocked(self):
        self.company.kemfai_setup_save_step('country', {'country': 'AE'}, None)
        self.company.kemfai_setup_save_step(
            'vat_tax', {'vat_tax_registration': '1' * 15}, None
        )
        # Switch to a country whose rule the existing VAT value will not match.
        self.env['kemfai.company.setup.country.rule'].sudo().create({
            'country_id': self.us.id,
            'vat_regex': r'[A-Z]{3}-\d{4}',
            'vat_format_hint': 'ABC-1234',
        })
        with self.assertRaisesRegex(ValidationError, 'KEMFAI_VAT_FORMAT'):
            with self.env.cr.savepoint():
                self.company.kemfai_setup_save_step('country', {'country': 'US'}, None)

    # -- T055: POST /companies/current/setup/complete (FR-028, Acceptance Scenario 3.7) --

    def _complete_all_seven_steps(self):
        self.company.kemfai_setup_save_step('country', {'country': 'AE'}, None)
        self.company.kemfai_setup_save_step(
            'identity', {'legal_name': 'Acme FZ', 'trade_name': 'Acme'}, None
        )
        self.company.kemfai_setup_save_step('currency', {'base_currency': 'AED'}, None)
        self.company.kemfai_setup_save_step(
            'fiscal_year', {'fiscal_year_start_month': '1', 'fiscal_year_start_day': 1}, None
        )
        self.company.kemfai_setup_save_step(
            'vat_tax', {'vat_tax_registration': '1' * 15}, None
        )
        self.company.kemfai_setup_save_step(
            'industry', {'industry': self._any_industry_id()}, None
        )
        self.company.kemfai_setup_save_step(
            'accounting_setup', {'accounting_setup_template': 'standard'}, None
        )

    def test_complete_with_missing_required_steps_is_rejected_and_stays_incomplete(self):
        self.company.kemfai_setup_save_step('country', {'country': 'AE'}, None)
        with self.assertRaisesRegex(ValidationError, 'KEMFAI_SETUP_INCOMPLETE'):
            self.company.kemfai_setup_complete()
        self.company.invalidate_recordset()
        self.assertFalse(self.company.setup_complete)
        self.assertFalse(self.company.setup_completed_at)

    def test_complete_after_all_seven_steps_marks_setup_complete_and_bumps_version(self):
        self._complete_all_seven_steps()
        v_before = self.company.setup_wizard_version
        result = self.company.kemfai_setup_complete()
        self.assertFalse(result['alreadyComplete'])
        self.assertTrue(result['setupComplete'])
        self.assertEqual(result['version'], v_before + 1)
        self.company.invalidate_recordset()
        self.assertTrue(self.company.setup_complete)
        self.assertTrue(self.company.setup_completed_at)

        # Resume/get-state also reflects completion.
        state = self.company.kemfai_setup_get_state()
        self.assertTrue(state['setupComplete'])

    def test_repeated_complete_call_is_idempotent_and_does_not_bump_version_again(self):
        self._complete_all_seven_steps()
        first = self.company.kemfai_setup_complete()
        self.assertFalse(first['alreadyComplete'])

        second = self.company.kemfai_setup_complete()
        self.assertTrue(second['alreadyComplete'])
        self.assertTrue(second['setupComplete'])
        # No further version bump on the already-complete no-op path.
        self.assertEqual(second['version'], first['version'])

    # -- T055: GET/PUT /companies/current/settings (FR-028) -----------------------------

    def test_settings_get_before_completion_is_blocked(self):
        self.company.kemfai_setup_save_step('country', {'country': 'AE'}, None)
        with self.assertRaisesRegex(ValidationError, 'KEMFAI_SETUP_INCOMPLETE'):
            self.company.kemfai_settings_get()

    def test_settings_update_before_completion_is_blocked_and_does_not_write(self):
        self.company.kemfai_setup_save_step('country', {'country': 'AE'}, None)
        with self.assertRaisesRegex(ValidationError, 'KEMFAI_SETUP_INCOMPLETE'):
            with self.env.cr.savepoint():
                self.company.kemfai_settings_update({'legal_name': 'Should Not Persist'})
        self.company.invalidate_recordset()
        self.assertNotEqual(self.company.legal_name, 'Should Not Persist')

    def test_settings_get_and_update_after_completion_edit_persisted_values_without_rerunning_wizard(self):
        self._complete_all_seven_steps()
        self.company.kemfai_setup_complete()

        view = self.company.kemfai_settings_get()
        self.assertTrue(view['setupComplete'])
        self.assertEqual(view['values']['legal_name'], 'Acme FZ')

        # Edits a setup-wizard-captured field through the DISTINCT settings surface —
        # never kemfai_setup_save_step/kemfai_setup_complete again (FR-028: "not by
        # re-running the wizard as the only path").
        result = self.company.kemfai_settings_update({'legal_name': 'Acme Holdings FZ'})
        self.assertEqual(result['changedFields'], ['legal_name'])
        self.assertEqual(result['values']['legal_name'], 'Acme Holdings FZ')
        self.assertTrue(result['setupComplete'])

        self.company.invalidate_recordset()
        self.assertEqual(self.company.legal_name, 'Acme Holdings FZ')
        # setup_complete / setup_wizard_version are untouched by a settings edit — this
        # surface never re-enters T054's wizard step/version bookkeeping.
        self.assertTrue(self.company.setup_complete)

    def test_settings_update_reuses_country_vat_revalidation(self):
        self._complete_all_seven_steps()
        self.company.kemfai_setup_complete()
        # SA has its own configured rule (also \d{15}); the existing 15-digit VAT value
        # must re-validate under the settings surface exactly as it does mid-wizard.
        result = self.company.kemfai_settings_update({'country': 'SA'})
        self.assertEqual(result['values']['country'], 'SA')
        self.assertEqual(result['values']['vat_tax_registration'], '1' * 15)

    def test_settings_update_with_no_recognized_field_is_rejected(self):
        self._complete_all_seven_steps()
        self.company.kemfai_setup_complete()
        with self.assertRaisesRegex(ValidationError, 'KEMFAI_REQUIRED_FIELD'):
            self.company.kemfai_settings_update({'not_a_field': 'x'})

    # -- T055 arbiter binding resolution point 2: durable idempotent receipt -----------

    def test_complete_with_same_operation_uuid_replays_receipt_without_reapplying(self):
        self._complete_all_seven_steps()
        op_uuid = 'op-complete-1'
        first = self.company.kemfai_setup_complete(op_uuid, '2026-10-05T00:00:00.000Z', 'actor-1')
        v_after_first = self.company.setup_wizard_version

        # A second call with the SAME operation UUID (simulating a retry that reaches
        # Odoo again after a lost response) must return the identical stored result and
        # must NOT re-run the mutation (no further version bump).
        second = self.company.kemfai_setup_complete(op_uuid, '2026-10-05T00:00:00.000Z', 'actor-1')
        self.assertEqual(first, second)
        self.company.invalidate_recordset()
        self.assertEqual(self.company.setup_wizard_version, v_after_first)

        receipts = self.env['kemfai.company.mutation.receipt'].search(
            [('operation_uuid', '=', op_uuid)]
        )
        self.assertEqual(len(receipts), 1)

    def test_settings_update_with_same_operation_uuid_replays_original_changed_fields(self):
        self._complete_all_seven_steps()
        self.company.kemfai_setup_complete()
        op_uuid = 'op-settings-1'
        first = self.company.kemfai_settings_update(
            {'legal_name': 'Acme Holdings FZ'}, op_uuid, '2026-10-05T00:00:00.000Z', 'actor-1'
        )
        self.assertEqual(first['changedFields'], ['legal_name'])

        # Repeat with a DIFFERENT submitted body but the SAME operation UUID: the
        # original stored changedFields/result must be returned, never recomputed from
        # this call's (different) values, and the company must not be mutated again.
        second = self.company.kemfai_settings_update(
            {'trade_name': 'Should Not Apply'}, op_uuid, '2026-10-05T00:00:00.000Z', 'actor-1'
        )
        self.assertEqual(first, second)
        self.company.invalidate_recordset()
        self.assertNotEqual(self.company.trade_name, 'Should Not Apply')


@tagged('post_install', '-at_install', 'kemfai_company_setup')
class TestCompanySetupWizardConcurrency(HttpCase):
    """Isolated into its own HttpCase: this is the only case in the module that
    spawns worker threads building their own api.Environment on independent
    DB connections. A plain TransactionCase holds a registry-lifecycle lock that
    is never released for the duration of the test, so a spawned thread's
    Environment() construction (Registry.__new__) deadlocks against the main
    test thread waiting on join(). HttpCase's setUpClass calls
    registry.enter_test_mode()/leave_test_mode() — the framework's own supported
    fixture for exactly this multi-thread scenario.
    """

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].search([], limit=1)
        self.assertTrue(self.company, 'tenant_core must seed exactly one company')

    def test_two_parallel_saves_commit_with_distinct_monotonic_versions_and_one_stale(self):
        company_id = self.company.id
        uid = self.env.uid
        # The company row itself is committed data (created at DB init), so the two
        # independent DB connections opened below see it without any test-cursor
        # commit. Each worker opens its own connection and calls kemfai_setup_save_step()
        # directly — the method under test is the ONLY thing that ever takes the row
        # lock (its own `SELECT ... FOR UPDATE`). An earlier version of this test had
        # one worker take a manual pre-lock on its connection and then call the same
        # method again on that already-locked connection; that reentrant double-lock
        # pattern is not how any real caller uses this API and produced a genuine
        # Postgres deadlock between the two worker connections. A `Barrier` instead
        # releases both workers at (as close to) the same instant, so whichever
        # connection's internal `SELECT ... FOR UPDATE` reaches Postgres first
        # legitimately wins the row lock and the other genuinely blocks on it —
        # real DB-level contention, with only one lock acquisition per connection.
        base_version = self.company.setup_wizard_version

        results = {}
        errors = {}
        start_barrier = threading.Barrier(2)

        def save(label, legal_name, trade_name):
            try:
                start_barrier.wait(timeout=5)
            except threading.BrokenBarrierError as exc:  # pragma: no cover
                errors[label] = exc
                return
            cr = db_connect(self.env.cr.dbname).cursor()
            try:
                env = api.Environment(cr, uid, {})

                def _do_save():
                    company = env['res.company'].browse(company_id)
                    return company.kemfai_setup_save_step(
                        'identity', {'legal_name': legal_name, 'trade_name': trade_name},
                        base_version,
                    )

                # Real Odoo JSON-RPC dispatcher behavior: retries on serializable
                # concurrent-update conflicts (SQLSTATE 40001), rolling back and
                # resetting the environment between attempts, then committing only
                # once the function returns without raising.
                results[label] = retrying(_do_save, env)
            except Exception as exc:  # pragma: no cover - surfaced via errors dict
                errors[label] = exc
            finally:
                cr.close()

        t_a = threading.Thread(target=save, args=('A', 'Legal-A', 'Trade-A'))
        t_b = threading.Thread(target=save, args=('B', 'Legal-B', 'Trade-B'))
        t_a.start()
        t_b.start()
        t_a.join(timeout=15)
        t_b.join(timeout=15)

        self.assertFalse(t_a.is_alive(), 'worker A did not terminate (hung/deadlocked)')
        self.assertFalse(t_b.is_alive(), 'worker B did not terminate (hung/deadlocked)')
        self.assertEqual(errors, {}, f'parallel saves raised: {errors}')
        self.assertIn('A', results)
        self.assertIn('B', results)

        versions = {results['A']['version'], results['B']['version']}
        self.assertEqual(len(versions), 2, 'versions must be distinct')
        self.assertEqual(min(versions), base_version + 1)
        self.assertEqual(max(versions), base_version + 2)

        stale_flags = [results['A']['stale'], results['B']['stale']]
        self.assertEqual(sum(1 for flag in stale_flags if flag), 1,
                          'exactly one of the two saves must report stale')

        # Both workers passed the SAME base_version. The second committer locks the
        # row only after the first has already advanced it, so its base_version
        # comparison is against a version that has moved on — it is the stale one,
        # and it is also the last writer (its version is base_version + 2).
        winner = 'A' if results['A']['version'] == base_version + 2 else 'B'
        loser = 'B' if winner == 'A' else 'A'
        self.assertTrue(results[winner]['stale'])
        self.assertFalse(results[loser]['stale'])
        self.assertEqual(results[winner]['version'], base_version + 2)
        self.assertEqual(results[loser]['version'], base_version + 1)
        expected = {'A': ('Legal-A', 'Trade-A'), 'B': ('Legal-B', 'Trade-B')}

        # Last writer (by lock-acquisition order, i.e. the higher-versioned saver)
        # wins the final persisted value. Read the committed outcome through a fresh,
        # independent DB connection of its own, separate from both worker connections
        # and this test's own transaction.
        with db_connect(self.env.cr.dbname).cursor() as cr:
            final = api.Environment(cr, uid, {})['res.company'].browse(company_id)
            expected_legal, expected_trade = expected[winner]
            self.assertEqual(final.legal_name, expected_legal)
            self.assertEqual(final.trade_name, expected_trade)
            self.assertEqual(final.setup_wizard_version, base_version + 2)
            # These two commits happened on real worker connections, so unlike every
            # other test's writes they survive this test. Restore the pristine
            # committed company state so sibling tests stay correct under ANY test
            # ordering, not just the default alphabetical one that happens to run
            # them first.
            final.write({
                'legal_name': False,
                'trade_name': False,
                'setup_wizard_version': base_version,
            })
            cr.commit()
