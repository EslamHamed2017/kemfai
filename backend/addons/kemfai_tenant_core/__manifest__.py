{
    "name": "KEMFAI Tenant Core",
    "version": "18.0.1.0.0",
    "summary": "Per-tenant bootstrap: initial company and base data",
    "description": """
KEMFAI Tenant Core
===================
Bootstraps a freshly provisioned tenant database: creates the tenant's
single initial company shell. No financial data is pre-populated by this
module (out of scope for Slice 1).
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
