// Test-only placeholders. Runtime worker construction still validates all credentials.
process.env.KEMFAI_ODOO_MASTER_PASSWORD ||= 'unit-only-master';
process.env.KEMFAI_TENANT_ADMIN_LOGIN ||= 'unit-only-login';
process.env.KEMFAI_TENANT_ADMIN_PASSWORD ||= 'unit-only-password';
