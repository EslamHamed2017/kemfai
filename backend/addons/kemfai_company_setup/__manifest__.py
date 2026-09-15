{
    "name": "KEMFAI Company Setup",
    "version": "18.0.1.0.0",
    "summary": "Setup-wizard fields on res.company and wizard state",
    "description": """
KEMFAI Company Setup
======================
Extends res.company with the fields captured by KEMFAI's own bilingual
setup wizard (country, identity, currency, fiscal year, VAT/tax,
industry, accounting-setup template) and tracks wizard step/completion
state. No native Odoo Settings UI is exposed to customers.
""",
    "category": "KEMFAI",
    "author": "KEMFAI",
    "license": "LGPL-3",
    "depends": ["base"],
    "data": [],
    "installable": True,
    "application": False,
    "auto_install": False,
}
