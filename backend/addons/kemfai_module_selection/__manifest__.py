{
    "name": "KEMFAI Module Selection",
    "version": "18.0.1.0.0",
    "summary": "Per-tenant enabled-feature cache mirrored from entitlements",
    "description": """
KEMFAI Module Selection
=========================
Mirrors the control-plane's resolved entitlement/feature-flag state into
the tenant database so Odoo-side logic can read a local, per-tenant cache
instead of calling the control-plane API on every request. This module
never originates entitlement decisions; the control-plane EntitlementsService
remains the single source of truth.
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
