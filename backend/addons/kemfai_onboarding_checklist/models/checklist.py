from odoo import api, models


class KemfaiOnboardingChecklist(models.AbstractModel):
    """Read-only, live readiness projection for the current Odoo company.

    No completion row or boolean is stored. Archiving or deleting the final qualifying
    source record therefore immediately reverses the corresponding signal.
    """

    _name = 'kemfai.onboarding.checklist'
    _description = 'KEMFAI Live Onboarding Readiness'

    @api.model
    def kemfai_get_state(self):
        company = self.env.company
        company_domain = [('company_id', 'in', [False, company.id])]
        customer_added = bool(self.env['res.partner'].search_count([
            ('active', '=', True), ('customer_rank', '>', 0), *company_domain,
        ], limit=1))
        bank_added = bool(self.env['account.journal'].search_count([
            ('active', '=', True), ('type', '=', 'bank'), ('bank_account_id', '!=', False),
            ('company_id', '=', company.id),
        ], limit=1)) or bool(self.env['res.partner.bank'].search_count([
            ('active', '=', True), ('partner_id', '=', company.partner_id.id),
        ], limit=1))
        product_added = bool(self.env['product.product'].search_count([
            ('active', '=', True), ('sale_ok', '=', True), *company_domain,
        ], limit=1))
        return {
            'customerAdded': customer_added,
            'bankAdded': bank_added,
            'productAdded': product_added,
            'firstInvoiceReady': customer_added and bank_added and product_added,
        }
