// Contract Jest fixture only: values permit Nest worker construction without real secrets.
// Missing credentials still fail in production; explicit startup tests remove each fixture.
process.env.KEMFAI_ODOO_MASTER_PASSWORD ??= 'contract-only-master';
process.env.KEMFAI_TENANT_ADMIN_LOGIN ??= 'contract-only-login';
process.env.KEMFAI_TENANT_ADMIN_PASSWORD ??= 'contract-only-password';
