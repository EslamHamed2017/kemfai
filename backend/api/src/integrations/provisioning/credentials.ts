export interface ProvisioningCredentials {
  master: string;
  login: string;
  password: string;
}
export function provisioningCredentials(
  env: NodeJS.ProcessEnv = process.env,
): ProvisioningCredentials {
  const master = env.KEMFAI_ODOO_MASTER_PASSWORD;
  const login = env.KEMFAI_TENANT_ADMIN_LOGIN;
  const password = env.KEMFAI_TENANT_ADMIN_PASSWORD;
  if (!master?.trim() || !login?.trim() || !password?.trim())
    throw new Error('Provisioning credentials are not configured');
  return { master, login, password };
}
