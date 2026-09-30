// Test-only placeholders. Runtime worker construction still validates all credentials.
process.env.KEMFAI_ODOO_MASTER_PASSWORD ||= 'unit-only-master';
process.env.KEMFAI_TENANT_ADMIN_LOGIN ||= 'unit-only-login';
process.env.KEMFAI_TENANT_ADMIN_PASSWORD ||= 'unit-only-password';

// Jest-only Redis isolation: never enqueue test jobs into production DB 0.
{
  const url = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
  url.pathname = '/13';
  process.env.REDIS_URL = url.toString();
}
