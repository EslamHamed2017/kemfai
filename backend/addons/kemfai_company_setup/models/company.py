from odoo import api, fields, models
from odoo.exceptions import ValidationError

from ..validation import (
    ConfigurationGapError,
    VatFormatError,
    validate_vat_tax_registration,
)

FISCAL_YEAR_START_MONTHS = [(str(i), str(i)) for i in range(1, 13)]

SETUP_WIZARD_STEPS = [
    ('country', 'Country'),
    ('identity', 'Identity'),
    ('currency', 'Currency'),
    ('fiscal_year', 'Fiscal Year'),
    ('vat_tax', 'VAT/Tax'),
    ('industry', 'Industry'),
    ('accounting_setup', 'Accounting Setup'),
]

ACCOUNTING_SETUP_TEMPLATES = [
    ('standard', 'Standard Chart of Accounts'),
]


class ResCompany(models.Model):
    _inherit = 'res.company'

    # country, base_currency: distinct from the native country_id/currency_id
    # so the setup wizard owns its own field set per data-model.md's Company
    # table, verbatim.
    country = fields.Many2one('res.country', string='Setup Country')
    legal_name = fields.Char()
    trade_name = fields.Char()
    base_currency = fields.Many2one('res.currency')
    fiscal_year_start_month = fields.Selection(FISCAL_YEAR_START_MONTHS)
    fiscal_year_start_day = fields.Integer()
    vat_tax_registration = fields.Char()
    industry = fields.Many2one('res.partner.industry')
    accounting_setup_template = fields.Selection(ACCOUNTING_SETUP_TEMPLATES)
    setup_wizard_step = fields.Selection(SETUP_WIZARD_STEPS, default='country')
    setup_complete = fields.Boolean(default=False)
    setup_completed_at = fields.Datetime()

    @api.constrains('country', 'vat_tax_registration')
    def _kemfai_check_vat_tax_registration(self):
        rules = self.env['kemfai.company.setup.country.rule'].sudo().search([])
        rules_by_country = {rule.country_id.id: rule.vat_regex for rule in rules}
        for company in self:
            if not company.country:
                continue
            try:
                validate_vat_tax_registration(
                    company.country.id, company.vat_tax_registration, rules_by_country
                )
            except ConfigurationGapError:
                raise ValidationError(
                    'KEMFAI_CONFIG_GAP: no VAT/tax validation rule is configured for '
                    f'country {company.country.display_name!r}.'
                )
            except VatFormatError:
                raise ValidationError(
                    'KEMFAI_VAT_FORMAT: vat_tax_registration does not match the '
                    f'expected format for country {company.country.display_name!r}.'
                )
