from odoo.tests.common import TransactionCase


class TestOnboardingChecklist(TransactionCase):
    def setUp(self):
        super().setUp()
        self.checklist = self.env['kemfai.onboarding.checklist']
        # Accounting bootstrap data may include a bank journal. Establish the
        # empty checklist precondition inside this test transaction only.
        self.env['account.journal'].search([
            ('active', '=', True),
            ('type', '=', 'bank'),
            ('company_id', '=', self.env.company.id),
        ]).write({'active': False})
        self.env['res.partner.bank'].search([
            ('active', '=', True),
            ('partner_id', '=', self.env.company.partner_id.id),
        ]).write({'active': False})

    def test_customer_bank_product_create_archive_delete_are_live(self):
        self.assertEqual(self.checklist.kemfai_get_state(), {
            'customerAdded': False,
            'bankAdded': False,
            'productAdded': False,
            'firstInvoiceReady': False,
        })
        customer = self.env['res.partner'].create({
            'name': 'T079 Customer', 'customer_rank': 1, 'company_id': self.env.company.id,
        })
        bank = self.env['res.partner.bank'].create({
            'acc_number': 'T079-ACCOUNT', 'partner_id': self.env.company.partner_id.id,
        })
        product = self.env['product.product'].create({
            'name': 'T079 Service', 'sale_ok': True, 'company_id': self.env.company.id,
        })
        self.assertEqual(self.checklist.kemfai_get_state(), {
            'customerAdded': True,
            'bankAdded': True,
            'productAdded': True,
            'firstInvoiceReady': True,
        })
        customer.unlink()
        self.assertFalse(self.checklist.kemfai_get_state()['customerAdded'])
        customer = self.env['res.partner'].create({
            'name': 'T079 Customer 2', 'customer_rank': 1, 'company_id': self.env.company.id,
        })
        bank.unlink()
        self.assertFalse(self.checklist.kemfai_get_state()['bankAdded'])
        bank = self.env['res.partner.bank'].create({
            'acc_number': 'T079-ACCOUNT-2', 'partner_id': self.env.company.partner_id.id,
        })
        product.active = False
        state = self.checklist.kemfai_get_state()
        self.assertFalse(state['productAdded'])
        self.assertFalse(state['firstInvoiceReady'])
        customer.unlink()
        bank.unlink()

    def test_current_company_scope_cannot_read_foreign_company_records(self):
        other = self.env['res.company'].create({'name': 'T079 Foreign Company'})
        self.env['res.partner'].create({
            'name': 'Foreign Customer', 'customer_rank': 1, 'company_id': other.id,
        })
        self.env['account.journal'].create({
            'name': 'Foreign Bank Journal', 'code': 'F81B', 'type': 'bank',
            'company_id': other.id,
        })
        self.env['res.partner.bank'].create({
            'acc_number': 'T079-FOREIGN-ACCOUNT',
            'partner_id': other.partner_id.id,
        })
        state = self.checklist.with_company(self.env.company).kemfai_get_state()
        self.assertFalse(state['customerAdded'])
        self.assertFalse(state['bankAdded'])

    def test_bank_journal_without_partner_bank_is_live_readiness(self):
        journal = self.env['account.journal'].create({
            'name': 'T081 Bank Journal',
            'code': 'T81B',
            'type': 'bank',
            'company_id': self.env.company.id,
        })
        self.assertFalse(journal.bank_account_id)
        self.assertTrue(self.checklist.kemfai_get_state()['bankAdded'])

        journal.active = False
        self.assertFalse(self.checklist.kemfai_get_state()['bankAdded'])
