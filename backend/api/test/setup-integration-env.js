// Integration Jest fixture only: allow AppModule to construct its worker in mocked tests.
// Live provisioning must supply real credentials; never inject placeholders for it.
if (process.env.KEMFAI_LIVE_PROVISION !== '1') {
  process.env.KEMFAI_ODOO_MASTER_PASSWORD ??= 'integration-only-master';
  process.env.KEMFAI_TENANT_ADMIN_LOGIN ??= 'integration-only-login';
  process.env.KEMFAI_TENANT_ADMIN_PASSWORD ??= 'integration-only-password';
}

// Jest-only Redis isolation: never enqueue test jobs into production DB 0.
const { integrationRedisUrl } = require('./integration-redis-url');
process.env.REDIS_URL = integrationRedisUrl();
