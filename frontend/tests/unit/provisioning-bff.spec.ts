/** @jest-environment node */
import type { AuthConfig } from '../../src/lib/auth/config';
import { getProvisioningWith, retryProvisioningWith } from '../../src/lib/auth/provisioning-bff';
import type { SessionStore, StoredSession } from '../../src/lib/auth/session-store';
const config: AuthConfig = {
  issuer: 'https://id.test',
  backchannelUrl: 'https://id.test',
  jwksUri: 'https://id.test/certs',
  clientId: 'client',
  redirectUri: 'https://app.test/auth/callback',
  apiUrl: 'https://api.test',
  redisUrl: 'redis://test',
};
const session = (accessToken: string): StoredSession => ({
  accessToken,
  refreshToken: 'private',
  accessExpiresAt: Date.now() + 3600000,
  refreshExpiresAt: Date.now() + 7200000,
});
const sessions: Record<string, StoredSession> = {
  alice: session('alice-token'),
  bob: session('bob-token'),
};
const store: SessionStore = {
  create: async () => 'alice',
  get: async (id) => sessions[id] ?? null,
  tryAcquireRefreshLock: async () => true,
  releaseRefreshLock: async () => undefined,
  rotateIfCurrent: async () => true,
  destroyIfCurrent: async () => true,
  destroy: async () => undefined,
};
const req = (origin?: string) =>
  new Request('https://app.test/api/tenants/me/provisioning-retry', {
    method: 'POST',
    headers: origin ? { origin } : {},
  });
const deps = (sessionId: string | undefined, fetcher: typeof fetch) => ({
  config,
  sessionId,
  store,
  fetcher,
});
/** See logout-bff.spec.ts: a __Host- cookie's deletion Set-Cookie must itself carry
 * Secure/Path=/ with no Domain, or the browser silently ignores it and the real cookie survives. */
function expectExpiredSessionCookie(response: Response): void {
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).not.toBeNull();
  expect(setCookie).toMatch(/^__Host-kemfai_session=;/);
  expect(setCookie).toContain('Secure');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('Path=/');
  expect(setCookie).toContain('Max-Age=0');
  expect(setCookie).toMatch(/SameSite=lax/i);
  expect(setCookie).not.toContain('Domain=');
}
test('CSRF rejects missing and foreign origins before upstream access', async () => {
  const fetcher = jest.fn();
  for (const origin of [undefined, 'https://evil.test', 'https://app.test.evil.test'])
    expect((await retryProvisioningWith(req(origin), deps('alice', fetcher))).status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
});
test('missing and expired session deny access and clear stale cookie', async () => {
  const fetcher = jest.fn();
  expect((await getProvisioningWith(deps(undefined, fetcher))).status).toBe(401);
  const expired = await retryProvisioningWith(req('https://app.test'), deps('expired', fetcher));
  expect(expired.status).toBe(401);
  expectExpiredSessionCookie(expired);
  expect(fetcher).not.toHaveBeenCalled();
});
test('fixed paths, per-session token isolation and redaction', async () => {
  const fetcher = jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: 'Failed',
          failureReason: 'private database error',
          tenantId: 'tenant-abc',
        }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
  // tenantId (a plain opaque identifier, part of the documented TenantStatus schema) is
  // forwarded; failureReason (which can carry raw upstream diagnostic text) stays stripped.
  expect(await (await getProvisioningWith(deps('alice', fetcher))).json()).toEqual({
    status: 'Failed',
    tenantId: 'tenant-abc',
  });
  expect(await (await getProvisioningWith(deps('bob', fetcher))).json()).toEqual({
    status: 'Failed',
    tenantId: 'tenant-abc',
  });
  expect(fetcher).toHaveBeenNthCalledWith(
    1,
    'https://api.test/tenants/me',
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer alice-token' }),
      cache: 'no-store',
    }),
  );
  expect(fetcher).toHaveBeenNthCalledWith(
    2,
    'https://api.test/tenants/me',
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer bob-token' }),
    }),
  );
});
test('retry POST hits the fixed provisioning-retry path', async () => {
  const fetcher = jest.fn(
    async () =>
      new Response(JSON.stringify({ status: 'Pending', tenantId: 'tenant-abc' }), {
        status: 202,
      }),
  ) as unknown as typeof fetch;
  expect(
    (await retryProvisioningWith(req('https://app.test'), deps('alice', fetcher))).status,
  ).toBe(202);
  expect(fetcher).toHaveBeenNthCalledWith(
    1,
    'https://api.test/tenants/me/provisioning-retry',
    expect.objectContaining({ method: 'POST' }),
  );
});
test.each([
  ['Pending', 'tenant-abc'],
  ['Ready', 'tenant-xyz'],
])('retry 202 forwards validated %s body with redaction', async (status, tenantId) => {
  const fetcher = jest.fn(
    async () =>
      new Response(JSON.stringify({ status, tenantId, failureReason: 'private diagnostic' }), {
        status: 202,
      }),
  ) as unknown as typeof fetch;
  const response = await retryProvisioningWith(req('https://app.test'), deps('alice', fetcher));
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ status, tenantId });
});
test.each(['{"status":"Failed","tenantId":"x"}', '{"status":"Creating","tenantId":"x"}', 'null', 'not json'])(
  'malformed or disallowed retry 202 body fails safely as a service error',
  async (raw) => {
    const fetcher = jest.fn(
      async () => new Response(raw, { status: 202 }),
    ) as unknown as typeof fetch;
    const response = await retryProvisioningWith(req('https://app.test'), deps('alice', fetcher));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ message: 'Provisioning unavailable' });
  },
);
test.each([401, 403, 404, 409, 503])(
  'propagates safe %s without exposing upstream body',
  async (status) => {
    const fetcher = jest.fn(
      async () => new Response('secret', { status }),
    ) as unknown as typeof fetch;
    const result = await retryProvisioningWith(req('https://app.test'), deps('alice', fetcher));
    expect(result.status).toBe(status);
    expect(await result.text()).not.toContain('secret');
  },
);
test('unknown status and network errors are safe', async () => {
  const invalid = jest.fn(
    async () => new Response('{"status":null}', { status: 200 }),
  ) as unknown as typeof fetch;
  expect(await (await getProvisioningWith(deps('alice', invalid))).json()).toEqual({
    status: 'Unknown',
  });
  const failing = jest.fn(async () => {
    throw new Error('private connection');
  }) as unknown as typeof fetch;
  const response = await getProvisioningWith(deps('alice', failing));
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('private connection');
});

test.each([403, 404, 503])('GET propagates safe %s without disclosing body', async (status) => {
  const fetcher = jest.fn(
    async () => new Response('upstream diagnostic', { status }),
  ) as unknown as typeof fetch;
  const response = await getProvisioningWith(deps('alice', fetcher));
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain('upstream diagnostic');
});
test('GET upstream 401 expires session cookie', async () => {
  const fetcher = jest.fn(
    async () => new Response('private', { status: 401 }),
  ) as unknown as typeof fetch;
  const response = await getProvisioningWith(deps('alice', fetcher));
  expect(response.status).toBe(401);
  expectExpiredSessionCookie(response);
});
