import { writeFile } from 'node:fs/promises';
import { startFakeKeycloak } from './fake-keycloak';

async function main(): Promise<void> {
  const output = process.env.T074_IDENTITY_OUTPUT;
  const tenantA = process.env.T074_TENANT_A_ID;
  const tenantB = process.env.T074_TENANT_B_ID;
  if (!output || !tenantA || !tenantB)
    throw new Error('T074 identity fixture configuration is incomplete');
  const issuer = 'http://127.0.0.1/realms/t074-owned';
  const audience = 'kemfai-api';
  const fixture = await startFakeKeycloak({ issuer, audience });
  const tokenA = await fixture.signAccessToken({
    sub: '07400000-0000-4000-8000-000000000001',
    roles: ['WorkspaceOwner'],
    tenantId: tenantA,
    expiresIn: '30m',
  });
  const tokenB = await fixture.signAccessToken({
    sub: '07400000-0000-4000-8000-000000000002',
    roles: ['WorkspaceOwner'],
    tenantId: tenantB,
    expiresIn: '30m',
  });
  const tokenNonOwner = await fixture.signAccessToken({
    sub: '07400000-0000-4000-8000-000000000001',
    roles: ['Accountant'],
    tenantId: tenantA,
    expiresIn: '30m',
  });
  await writeFile(
    output,
    JSON.stringify({ issuer, audience, jwksUri: fixture.jwksUri, tokenA, tokenB, tokenNonOwner }),
    { mode: 0o600 },
  );
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await new Promise(() => undefined);
}
void main();
