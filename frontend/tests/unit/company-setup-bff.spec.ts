/** @jest-environment node */
import type { AuthConfig } from '../../src/lib/auth/config';
import {
  completeCompanySetupWith,
  getCompanySetupWith,
  putCompanySetupWith,
} from '../../src/lib/auth/company-setup-bff';
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
const sessions: Record<string, StoredSession> = { alice: session('alice-token') };
const store: SessionStore = {
  create: async () => 'alice',
  get: async (id) => sessions[id] ?? null,
  tryAcquireRefreshLock: async () => true,
  releaseRefreshLock: async () => undefined,
  rotateIfCurrent: async () => true,
  destroyIfCurrent: async () => true,
  destroy: async () => undefined,
};
const deps = (sessionId: string | undefined, fetcher: typeof fetch) => ({ config, sessionId, store, fetcher });
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
// T056 round 3 — X-KEMFAI-Setup-Scope is REQUIRED on every PUT/POST; every test below
// that expects to actually reach the upstream fetcher must supply one. `putReq`/
// `completeReq` default to a valid scope so pre-existing origin/auth/forwarding cases
// are unaffected by this requirement; tests that specifically target the requirement
// pass `scope: null` (omitted header) or `''` (blank header) explicitly.
const putReq = (origin?: string, scope: string | null = 'scope-alpha') =>
  new Request('https://app.test/api/companies/current/setup', {
    method: 'PUT',
    headers: { ...(origin ? { origin } : {}), ...(scope !== null ? { 'x-kemfai-setup-scope': scope } : {}) },
  });
const completeReq = (origin?: string, scope: string | null = 'scope-alpha') =>
  new Request('https://app.test/api/companies/current/setup/complete', {
    method: 'POST',
    headers: { ...(origin ? { origin } : {}), ...(scope !== null ? { 'x-kemfai-setup-scope': scope } : {}) },
  });

test('CSRF rejects missing and foreign origins on PUT/POST before upstream access', async () => {
  const fetcher = jest.fn();
  for (const origin of [undefined, 'https://evil.test']) {
    expect(
      (await putCompanySetupWith(putReq(origin), { step: 'country', values: { country: 'AE' } }, deps('alice', fetcher)))
        .status,
    ).toBe(403);
    expect((await completeCompanySetupWith(completeReq(origin), deps('alice', fetcher))).status).toBe(403);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

test('missing and expired session deny access and clear stale cookie', async () => {
  const fetcher = jest.fn();
  expect((await getCompanySetupWith(deps(undefined, fetcher))).status).toBe(401);
  const expired = await putCompanySetupWith(
    putReq('https://app.test'),
    { step: 'country', values: { country: 'AE' } },
    deps('expired', fetcher),
  );
  expect(expired.status).toBe(401);
  expectExpiredSessionCookie(expired);
  expect(fetcher).not.toHaveBeenCalled();
});

test('GET forwards bearer and passes the body/status through unchanged', async () => {
  const body = { currentStep: 'identity', setupComplete: false, values: { country: 'AE' }, version: 1, stale: false };
  const fetcher = jest.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const response = await getCompanySetupWith(deps('alice', fetcher));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(body);
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.test/companies/current/setup',
    expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ authorization: 'Bearer alice-token' }) }),
  );
});

test('PUT forwards the step payload and surfaces 422/409 bodies for client-side classification', async () => {
  const fetcher422 = jest.fn(async () => new Response(JSON.stringify({ statusCode: 422, message: 'country is required.' }), { status: 422 })) as unknown as typeof fetch;
  const response422 = await putCompanySetupWith(
    putReq('https://app.test'),
    { step: 'country', values: { country: '' } },
    deps('alice', fetcher422),
  );
  expect(response422.status).toBe(422);
  expect(await response422.json()).toEqual({ statusCode: 422, message: 'country is required.' });

  const fetcher409 = jest.fn(async () => new Response(JSON.stringify({ statusCode: 409, message: 'No VAT/tax validation rule is configured for this country' }), { status: 409 })) as unknown as typeof fetch;
  const response409 = await putCompanySetupWith(
    putReq('https://app.test'),
    { step: 'vat_tax', values: { vat_tax_registration: 'X' } },
    deps('alice', fetcher409),
  );
  expect(response409.status).toBe(409);
  expect(fetcher409).toHaveBeenCalledWith(
    'https://api.test/companies/current/setup',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ step: 'vat_tax', values: { vat_tax_registration: 'X' } }),
    }),
  );
});

test('upstream 401 on PUT/POST clears the session cookie', async () => {
  const fetcher = jest.fn(async () => new Response('private', { status: 401 })) as unknown as typeof fetch;
  const response = await completeCompanySetupWith(completeReq('https://app.test'), deps('alice', fetcher));
  expect(response.status).toBe(401);
  expectExpiredSessionCookie(response);
});

test('T056 — PUT/POST forward an incoming X-KEMFAI-Setup-Scope header upstream unchanged', async () => {
  const fetcher = jest.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
  const putReqWithScope = new Request('https://app.test/api/companies/current/setup', {
    method: 'PUT',
    headers: { origin: 'https://app.test', 'x-kemfai-setup-scope': 'scope-alpha' },
  });
  await putCompanySetupWith(putReqWithScope, { step: 'country', values: { country: 'AE' } }, deps('alice', fetcher));
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.test/companies/current/setup',
    expect.objectContaining({ headers: expect.objectContaining({ 'x-kemfai-setup-scope': 'scope-alpha' }) }),
  );

  const completeReqWithScope = new Request('https://app.test/api/companies/current/setup/complete', {
    method: 'POST',
    headers: { origin: 'https://app.test', 'x-kemfai-setup-scope': 'scope-beta' },
  });
  await completeCompanySetupWith(completeReqWithScope, deps('alice', fetcher));
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.test/companies/current/setup/complete',
    expect.objectContaining({ headers: expect.objectContaining({ 'x-kemfai-setup-scope': 'scope-beta' }) }),
  );
});

test('T056 round 3 — a PUT/POST with a MISSING X-KEMFAI-Setup-Scope header is rejected 412 by the BFF itself, before touching the upstream fetcher — no first-save exception', async () => {
  const fetcher = jest.fn();
  const putResponse = await putCompanySetupWith(
    putReq('https://app.test', null),
    { step: 'country', values: { country: 'AE' } },
    deps('alice', fetcher),
  );
  expect(putResponse.status).toBe(412);
  const completeResponse = await completeCompanySetupWith(completeReq('https://app.test', null), deps('alice', fetcher));
  expect(completeResponse.status).toBe(412);
  expect(fetcher).not.toHaveBeenCalled();
});

test('T056 round 3 — a PUT/POST with a BLANK (whitespace-only) X-KEMFAI-Setup-Scope header is also rejected 412 before the upstream fetcher', async () => {
  const fetcher = jest.fn();
  const putResponse = await putCompanySetupWith(
    putReq('https://app.test', '   '),
    { step: 'country', values: { country: 'AE' } },
    deps('alice', fetcher),
  );
  expect(putResponse.status).toBe(412);
  const completeResponse = await completeCompanySetupWith(completeReq('https://app.test', '   '), deps('alice', fetcher));
  expect(completeResponse.status).toBe(412);
  expect(fetcher).not.toHaveBeenCalled();
});

test('network failure is a safe 502, never a raw error leak', async () => {
  const fetcher = jest.fn(async () => {
    throw new Error('private connection detail');
  }) as unknown as typeof fetch;
  const response = await getCompanySetupWith(deps('alice', fetcher));
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('private connection detail');
});
