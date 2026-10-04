from odoo import fields, models


class KemfaiCompanySetupCountryRule(models.Model):
    """Per-country VAT/tax-registration format rule.

    A launch country with no row here has no configured rule; the setup
    wizard must block with a configuration-gap signal rather than silently
    accepting an unvalidated value (data-model.md's Company validation note).
    """

    _name = 'kemfai.company.setup.country.rule'
    _description = 'KEMFAI Company Setup Country Validation Rule'

    country_id = fields.Many2one('res.country', required=True, index=True)
    vat_regex = fields.Char(
        required=True,
        help="Python regex a country's vat_tax_registration value must fully match.",
    )
    vat_format_hint = fields.Char(
        help='Human-readable example shown to the user for this country, e.g. "123456789".',
    )

    _sql_constraints = [
        (
            'country_unique',
            'unique(country_id)',
            'A validation rule already exists for this country.',
        ),
    ]
