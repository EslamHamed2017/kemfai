import { randomUUID } from 'node:crypto';

type LiveIdentity = {
  token: string;
  companyId: string;
};

type JsonResponse = {
  status: number;
  body: Record<string, unknown>;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`T027 requires exact-owned live fixture variable ${name}`);
  }
  return value;
}

function identity(tokenName: string, companyName: string): LiveIdentity {
  return { token: required(tokenName), companyId: required(companyName) };
}

type FixtureUser = 'A' | 'B';
type FixtureCompany = 'A1' | 'A2' | 'B1';

function fixtureIdentity(user: FixtureUser, company: FixtureCompany): LiveIdentity {
  const prefix = ['KEMFAI', 'AF'];
  return identity(
    [...prefix, 'USER', user, 'TOKEN'].join('_'),
    [...prefix, 'COMPANY', company, 'ID'].join('_'),
  );
}

async function api(
  identityContext: LiveIdentity,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<JsonResponse> {
  const response = await fetch(`${required('KEMFAI_AF_API_BASE_URL')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${identityContext.token}`,
      'x-kemfai-company-id': identityContext.companyId,
      'accept-language': 'en',
      'x-correlation-id': randomUUID(),
      ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function createAccount(who: LiveIdentity, label: string): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const created = await api(who, 'POST', '/v1/accounting/accounts', {
    code: `T027.${label.replace(/[^A-Za-z0-9]/g, '')}.${suffix}`,
    name: { en: `Isolation ${label}`, ar: `عزل ${label}` },
    accountType: 'asset_current',
    nodeKind: 'posting',
    active: true,
  });
  expect(created.status).toBe(201);
  const resource = created.body.resource as Record<string, unknown>;
  expect(resource.id).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
  const serialized = JSON.stringify(created.body);
  expect(serialized).not.toMatch(/odoo|account\.account|res\./i);
  return resource.id as string;
}

function expectOpaqueNotFound(response: JsonResponse, exactId: string): void {
  expect(response.status).toBe(404);
  expect(JSON.stringify(response.body)).not.toContain(exactId);
  expect(JSON.stringify(response.body)).not.toMatch(/tenant|database|odoo|company mismatch/i);
}

describe('Accounting real-RPC tenant/company isolation (T027)', () => {
  it('isolates Tenant A company A1 resources from the ordinary A2 company context', async () => {
    const userACompanyA1 = fixtureIdentity('A', 'A1');
    const userACompanyA2 = fixtureIdentity('A', 'A2');
    const exactId = await createAccount(userACompanyA1, 'A1');

    const ownerRead = await api(userACompanyA1, 'GET', `/v1/accounting/accounts/${exactId}`);
    expect(ownerRead.status).toBe(200);
    expect((ownerRead.body as { id?: string }).id).toBe(exactId);

    const crossCompany = await api(userACompanyA2, 'GET', `/v1/accounting/accounts/${exactId}`);
    expectOpaqueNotFound(crossCompany, exactId);
  });

  it('has User B create/fetch a real UUID before User A attempts that exact UUID opaquely', async () => {
    const userB = fixtureIdentity('B', 'B1');
    const userA = fixtureIdentity('A', 'A1');

    const exactTenantBId = await createAccount(userB, 'B1-FIRST');
    const tenantBOwnerRead = await api(userB, 'GET', `/v1/accounting/accounts/${exactTenantBId}`);
    expect(tenantBOwnerRead.status).toBe(200);
    expect((tenantBOwnerRead.body as { id?: string }).id).toBe(exactTenantBId);

    const tenantAAttempt = await api(userA, 'GET', `/v1/accounting/accounts/${exactTenantBId}`);
    expectOpaqueNotFound(tenantAAttempt, exactTenantBId);
  });
});
