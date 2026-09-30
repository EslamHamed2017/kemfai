"""Ensure exactly one company in a freshly initialized tenant database."""
def ensure_initial_company(env):
    companies = env['res.company'].sudo().search([])
    if len(companies) > 1:
        raise ValueError('Tenant database contains multiple companies')
    if not companies:
        env['res.company'].sudo().create({'name': 'KEMFAI'})
