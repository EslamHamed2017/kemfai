// Contract Jest fixture only: values permit Nest worker construction without real secrets.
// Missing credentials still fail in production; explicit startup tests remove each fixture.
process.env.KEMFAI_ODOO_MASTER_PASSWORD ??= 'contract-only-master';
process.env.KEMFAI_TENANT_ADMIN_LOGIN ??= 'contract-only-login';
process.env.KEMFAI_TENANT_ADMIN_PASSWORD ??= 'contract-only-password';

// Jest-only Redis isolation: never enqueue test jobs into production DB 0.
{
  const url = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
  url.pathname = '/15';
  process.env.REDIS_URL = url.toString();
}
