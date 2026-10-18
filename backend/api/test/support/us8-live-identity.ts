import { writeFile } from 'node:fs/promises';
import { startFakeKeycloak } from './fake-keycloak';

async function main() {
  const output = process.env.US8_IDENTITY_OUTPUT;
  const tenantA = process.env.US8_TENANT_A_ID;
  const tenantB = process.env.US8_TENANT_B_ID;
  if (!output || !tenantA || !tenantB)
    throw new Error('US8 identity fixture configuration is incomplete');
  const customerIssuer = 'http://127.0.0.1/realms/us8-customers';
  const internalIssuer = 'http://127.0.0.1/realms/us8-internal';
  const audience = 'kemfai-api';
  const fixture = await startFakeKeycloak({ issuer: customerIssuer, audience });
  const ownerA = await fixture.signAccessToken({
    sub: '08400000-0000-4000-8000-000000000001',
    roles: ['WorkspaceOwner'],
    tenantId: tenantA,
    expiresIn: '30m',
  });
  const ownerB = await fixture.signAccessToken({
    sub: '08400000-0000-4000-8000-000000000002',
    roles: ['WorkspaceOwner'],
    tenantId: tenantB,
    expiresIn: '30m',
  });
  const support = await fixture.signAccessToken({
    sub: '08400000-0000-4000-8000-000000000003',
    issuer: internalIssuer,
    roles: ['Support'],
    expiresIn: '30m',
  });
  const customerSupportSpoof = await fixture.signAccessToken({
    sub: '08400000-0000-4000-8000-000000000001',
    roles: ['Support'],
    tenantId: tenantA,
    expiresIn: '30m',
  });
  await writeFile(
    output,
    JSON.stringify({
      customerIssuer,
      internalIssuer,
      audience,
      jwksUri: fixture.jwksUri,
      ownerA,
      ownerB,
      support,
      customerSupportSpoof,
    }),
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
