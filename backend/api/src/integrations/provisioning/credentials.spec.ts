import { provisioningCredentials } from './credentials';

const configured = {
  KEMFAI_ODOO_MASTER_PASSWORD: 'master',
  KEMFAI_TENANT_ADMIN_LOGIN: 'admin',
  KEMFAI_TENANT_ADMIN_PASSWORD: 'secret',
};

const keys = Object.keys(configured) as (keyof typeof configured)[];

describe('provisioningCredentials', () => {
  it.each(keys)('rejects missing or blank %s', (key) => {
    for (const value of [undefined, '', ' ', '\t\n ']) {
      const env: NodeJS.ProcessEnv = { ...configured };
      if (value === undefined) delete env[key];
      else env[key] = value;
      expect(() => provisioningCredentials(env)).toThrow(
        'Provisioning credentials are not configured',
      );
    }
  });

  it('preserves every nonblank configured credential exactly, including outer whitespace', () => {
    const env = {
      KEMFAI_ODOO_MASTER_PASSWORD: '  master secret \t',
      KEMFAI_TENANT_ADMIN_LOGIN: '\n admin@example.test  ',
      KEMFAI_TENANT_ADMIN_PASSWORD: '\t password with spaces \n',
    };
    expect(provisioningCredentials(env)).toEqual({
      master: env.KEMFAI_ODOO_MASTER_PASSWORD,
      login: env.KEMFAI_TENANT_ADMIN_LOGIN,
      password: env.KEMFAI_TENANT_ADMIN_PASSWORD,
    });
  });
});
