/** @jest-environment node */
import type { AuthConfig } from '../../src/lib/auth/config';
import {
  getCompanySettingsWith,
  putCompanySettingsWith,
} from '../../src/lib/auth/company-settings-bff';
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
const session: StoredSession = {
  accessToken: 'alice-token',
  refreshToken: 'private',
  accessExpiresAt: Date.now() + 3_600_000,
  refreshExpiresAt: Date.now() + 7_200_000,
};
const store: SessionStore = {
  create: async () => 'alice',
  get: async (id) => (id === 'alice' ? session : null),
  tryAcquireRefreshLock: async () => true,
  releaseRefreshLock: async () => undefined,
  rotateIfCurrent: async () => true,
  destroyIfCurrent: async () => true,
  destroy: async () => undefined,
};
const deps = (sessionId: string | undefined, fetcher: typeof fetch) => ({
  config,
  sessionId,
  store,
  fetcher,
});

test('GET forwards the authenticated request without exposing the token to the browser', async () => {
  const body = { values: { country: 'AE' }, setupComplete: true };
  const fetcher = jest.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;

  const result = await getCompanySettingsWith(deps('alice', fetcher));

  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(body);
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.test/companies/current/settings',
    expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer alice-token' }),
    }),
  );
});

test('PUT rejects a missing or foreign Origin before any upstream mutation', async () => {
  const fetcher = jest.fn();
  for (const origin of [undefined, 'https://evil.test']) {
    const request = new Request('https://app.test/api/companies/current/settings', {
      method: 'PUT',
      headers: origin ? { origin } : undefined,
    });
    const result = await putCompanySettingsWith(
      request,
      { values: { legal_name: 'Acme' } },
      deps('alice', fetcher),
    );
    expect(result.status).toBe(403);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

test('PUT forwards the values and idempotency key for a same-origin request', async () => {
  const fetcher = jest.fn(
    async () => new Response(null, { status: 200 }),
  ) as unknown as typeof fetch;
  const request = new Request('https://app.test/api/companies/current/settings', {
    method: 'PUT',
    headers: { origin: 'https://app.test', 'idempotency-key': 'edit-123' },
  });

  const result = await putCompanySettingsWith(
    request,
    { values: { legal_name: 'Acme Holdings' } },
    deps('alice', fetcher),
  );

  expect(result.status).toBe(200);
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.test/companies/current/settings',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ values: { legal_name: 'Acme Holdings' } }),
      headers: expect.objectContaining({
        authorization: 'Bearer alice-token',
        'idempotency-key': 'edit-123',
      }),
    }),
  );
});

test('network failures become a generic 502 without leaking internal detail', async () => {
  const fetcher = jest.fn(async () => {
    throw new Error('private upstream address');
  }) as unknown as typeof fetch;

  const result = await getCompanySettingsWith(deps('alice', fetcher));

  expect(result.status).toBe(502);
  expect(await result.text()).not.toContain('private upstream address');
});
