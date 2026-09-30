import { TenantProvisionProcessor } from './tenant-provision.processor';
import { BillingCycle } from '../../modules/accounts/entities/account.entity';
import { initialPeriod } from './period';
import { provisioningCredentials } from './credentials';

describe('initial inclusive UTC period', () => {
  it.each([
    ['2026-01-31', BillingCycle.MONTHLY, '2026-02-27'],
    ['2024-02-29', BillingCycle.ANNUAL, '2025-02-27'],
    ['2026-12-31', BillingCycle.MONTHLY, '2027-01-30'],
  ])('%s %s ends %s', (start, cycle, end) => {
    expect(initialPeriod(new Date(`${start}T23:59:59Z`), cycle)).toEqual({ start, end });
  });
});
describe('provisioning credentials fail closed', () => {
  it.each([
    'KEMFAI_ODOO_MASTER_PASSWORD',
    'KEMFAI_TENANT_ADMIN_LOGIN',
    'KEMFAI_TENANT_ADMIN_PASSWORD',
  ])('requires %s', (key) => {
    const env = {
      KEMFAI_ODOO_MASTER_PASSWORD: 'master',
      KEMFAI_TENANT_ADMIN_LOGIN: 'admin',
      KEMFAI_TENANT_ADMIN_PASSWORD: 'secret',
    };
    delete (env as Record<string, string | undefined>)[key];
    expect(() => provisioningCredentials(env)).toThrow(
      'Provisioning credentials are not configured',
    );
    expect(() => provisioningCredentials({ ...env, [key]: '   ' })).toThrow();
  });
});

describe('worker startup validation', () => {
  it('refuses to instantiate without any privileged credential, regardless of NODE_ENV', () => {
    const names = [
      'KEMFAI_ODOO_MASTER_PASSWORD',
      'KEMFAI_TENANT_ADMIN_LOGIN',
      'KEMFAI_TENANT_ADMIN_PASSWORD',
    ] as const;
    const saved = names.map((name) => process.env[name]);
    const oldEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      names.forEach((name) => {
        delete process.env[name];
      });
      expect(
        () => new TenantProvisionProcessor({} as never, {} as never, {} as never, {} as never),
      ).toThrow('Provisioning credentials are not configured');
      process.env.NODE_ENV = 'production';
      expect(
        () => new TenantProvisionProcessor({} as never, {} as never, {} as never, {} as never),
      ).toThrow('Provisioning credentials are not configured');
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      });
      process.env.NODE_ENV = oldEnv;
    }
  });
});
