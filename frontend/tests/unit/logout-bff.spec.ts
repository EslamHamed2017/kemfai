/** @jest-environment node */
import type { AuthConfig } from '../../src/lib/auth/config';
import { defaultProviderLogout, postLogoutWith } from '../../src/lib/auth/logout-bff';
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
const session = (refreshToken = 'private-refresh'): StoredSession => ({
  accessToken: 'token',
  refreshToken,
  accessExpiresAt: Date.now() + 3600000,
  refreshExpiresAt: Date.now() + 7200000,
});

/**
 * A `__Host-`-prefixed cookie's deletion Set-Cookie MUST itself carry `Secure` (and
 * `Path=/`, no `Domain`) or the browser rejects the header outright and the
 * login-issued cookie survives untouched — `toContain('__Host-kemfai_session')` alone
 * does not catch that regression, since the broken `response.cookies.delete(name)` form
 * also contains the cookie name. Assert the exact attribute shape instead.
 */
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

/**
 * T056 point 2 (corrective) — same-origin logout that genuinely reaches Keycloak:
 * CSRF-rejected on a foreign/missing origin BEFORE any store/provider work; every
 * valid-origin path always attempts local destruction and always expires the session
 * cookie, even when the provider call fails, times out, races a concurrent refresh, or
 * the session record cannot be read — but only a provider-CONFIRMED termination is ever
 * reported as success. A provider failure is never encoded as a successful account
 * switch.
 */
describe('postLogoutWith (T056 point 2)', () => {
  function makeStore(initial: Record<string, StoredSession>) {
    const sessions = { ...initial };
    const destroy = jest.fn(async (id: string) => {
      delete sessions[id];
    });
    const destroyIfCurrent = jest.fn(async (id: string, refreshToken: string) => {
      if (sessions[id]?.refreshToken !== refreshToken) return false;
      delete sessions[id];
      return true;
    });
    const tryAcquireRefreshLock = jest.fn(async () => true);
    const releaseRefreshLock = jest.fn(async () => undefined);
    const store: SessionStore = {
      create: async () => 'id',
      get: async (id) => sessions[id] ?? null,
      tryAcquireRefreshLock,
      releaseRefreshLock,
      rotateIfCurrent: async () => true,
      destroyIfCurrent,
      destroy,
    };
    return {
      store,
      sessions,
      destroy,
      destroyIfCurrent,
      tryAcquireRefreshLock,
      releaseRefreshLock,
    };
  }

  const req = (origin?: string) =>
    new Request('https://app.test/api/auth/logout', {
      method: 'POST',
      headers: origin ? { origin } : {},
    });

  it('rejects a missing origin before touching the session store', async () => {
    const { store, destroy, tryAcquireRefreshLock } = makeStore({ alice: session() });
    const providerLogout = jest.fn();
    const response = await postLogoutWith(req(undefined), {
      config,
      sessionId: 'alice',
      store,
      providerLogout,
    });
    expect(response.status).toBe(403);
    expect(destroy).not.toHaveBeenCalled();
    expect(tryAcquireRefreshLock).not.toHaveBeenCalled();
    expect(providerLogout).not.toHaveBeenCalled();
  });

  it('rejects a foreign origin before touching the session store', async () => {
    const { store, destroy } = makeStore({ alice: session() });
    const providerLogout = jest.fn();
    const response = await postLogoutWith(req('https://evil.test'), {
      config,
      sessionId: 'alice',
      store,
      providerLogout,
    });
    expect(response.status).toBe(403);
    expect(destroy).not.toHaveBeenCalled();
    expect(providerLogout).not.toHaveBeenCalled();
  });

  it('every response carries Cache-Control: no-store', async () => {
    const { store } = makeStore({ alice: session() });
    const providerLogout = jest.fn(async () => true);
    const response = await postLogoutWith(req('https://app.test'), {
      config,
      sessionId: 'alice',
      store,
      providerLogout,
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('provider-confirmed logout: calls the provider BEFORE destroying the local record, with the current refresh token, destroys exactly that session, and reports success', async () => {
    const calls: string[] = [];
    const { store, destroyIfCurrent, sessions } = makeStore({ alice: session('alice-refresh') });
    const providerLogout = jest.fn(async (refreshToken: string) => {
      calls.push(`provider:${refreshToken}`);
      return true;
    });
    const wrappedDestroy = destroyIfCurrent.mockImplementation(
      async (id: string, refreshToken: string) => {
        calls.push(`destroy:${id}:${refreshToken}`);
        if (sessions[id]?.refreshToken !== refreshToken) return false;
        delete sessions[id];
        return true;
      },
    );

    const response = await postLogoutWith(req('https://app.test'), {
      config,
      sessionId: 'alice',
      store,
      providerLogout,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'confirmed' });
    expect(providerLogout).toHaveBeenCalledWith('alice-refresh', config);
    expect(wrappedDestroy).toHaveBeenCalledWith('alice', 'alice-refresh');
    expect(calls).toEqual(['provider:alice-refresh', 'destroy:alice:alice-refresh']);
    expect(sessions.alice).toBeUndefined();
    expectExpiredSessionCookie(response);
  });

  it('provider 5xx/non-204 response: local destroy still attempted, cookie still expired, outcome is unconfirmed (never success)', async () => {
    const { store, destroy, sessions } = makeStore({ alice: session() });
    const providerLogout = jest.fn(async () => false);
    const response = await postLogoutWith(req('https://app.test'), {
      config,
      sessionId: 'alice',
      store,
      providerLogout,
    });

    expect(response.status).not.toBe(200);
    expect((await response.json()).outcome).toBe('unconfirmed');
    expect(destroy).toHaveBeenCalledWith('alice');
    expect(sessions.alice).toBeUndefined();
    expectExpiredSessionCookie(response);
  });

  it('provider timeout/transport error (providerLogout throws): local destroy still attempted, cookie still expired, unconfirmed', async () => {
    const { store, destroy, sessions } = makeStore({ alice: session() });
    const providerLogout = jest.fn(async () => {
      throw new Error('fetch failed: ETIMEDOUT');
    });
    const response = await postLogoutWith(req('https://app.test'), {
      config,
      sessionId: 'alice',
      store,
      providerLogout,
    });

    expect((await response.json()).outcome).toBe('unconfirmed');
    expect(destroy).toHaveBeenCalledWith('alice');
    expect(sessions.alice).toBeUndefined();
    expectExpiredSessionCookie(response);
  });

  it('lock contention (another request currently owns the refresh lock): local destroy still attempted, cookie still expired, unconfirmed, provider never called', async () => {
    const { store, destroy, releaseRefreshLock } = makeStore({ alice: session() });
    (store.tryAcquireRefreshLock as jest.Mock) = jest.fn(async () => false);
    const providerLogout = jest.fn();
    const response = await postLogoutWith(req('https://app.test'), {
      config,
      sessionId: 'alice',
      store,
      providerLogout,
    });

    expect((await response.json()).outcome).toBe('unconfirmed');
    expect(providerLogout).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledWith('alice');
    expect(releaseRefreshLock).not.toHaveBeenCalled(); // never held the lock — nothing to release
    expectExpiredSessionCookie(response);
  });

  it('session-read failure (store.get rejects): local destroy still attempted, cookie still expired, unconfirmed, provider never called', async () => {
    const { store, destroy } = makeStore({ alice: session() });
    (store.get as jest.Mock) = jest.fn(async () => {
      throw new Error('redis read failed');
    });
    const providerLogout = jest.fn();
    const response = await postLogoutWith(req('https://app.test'), {
      config,
      sessionId: 'alice',
      store,
      providerLogout,
    });

    expect((await response.json()).outcome).toBe('unconfirmed');
    expect(providerLogout).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledWith('alice');
    expectExpiredSessionCookie(response);
  });

  it('missing session record (store.get returns null): local destroy still attempted, cookie still expired, unconfirmed, provider never called', async () => {
    const { store, destroy } = makeStore({});
    const providerLogout = jest.fn();
    const response = await postLogoutWith(req('https://app.test'), {
      config,
      sessionId: 'alice',
      store,
      providerLogout,
    });

    expect((await response.json()).outcome).toBe('unconfirmed');
    expect(providerLogout).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledWith('alice');
    expectExpiredSessionCookie(response);
  });

  it('is idempotent: a call with no session id is a confirmed success and still expires the cookie, with no provider call', async () => {
    const { store, destroy } = makeStore({});
    const providerLogout = jest.fn();
    const response = await postLogoutWith(req('https://app.test'), {
      config,
      sessionId: undefined,
      store,
      providerLogout,
    });

    expect(response.status).toBe(200);
    expect((await response.json()).outcome).toBe('confirmed');
    expect(providerLogout).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expectExpiredSessionCookie(response);
  });

  it('Redis deletion failure AFTER provider confirmation still expires the cookie and still reports success (TTL contains the stale record)', async () => {
    const { store, destroyIfCurrent } = makeStore({ alice: session() });
    (store.destroyIfCurrent as jest.Mock) = jest.fn(async () => {
      throw new Error('ECONNREFUSED: redis down');
    });
    const providerLogout = jest.fn(async () => true);
    const response = await postLogoutWith(req('https://app.test'), {
      config,
      sessionId: 'alice',
      store,
      providerLogout,
    });

    expect(response.status).toBe(200);
    expect((await response.json()).outcome).toBe('confirmed');
    expectExpiredSessionCookie(response);
  });

  it('releases the acquired lock even when the provider call throws, without suppressing cookie expiry', async () => {
    const { store, releaseRefreshLock } = makeStore({ alice: session() });
    const providerLogout = jest.fn(async () => {
      throw new Error('boom');
    });
    const response = await postLogoutWith(req('https://app.test'), {
      config,
      sessionId: 'alice',
      store,
      providerLogout,
    });
    expect(releaseRefreshLock).toHaveBeenCalled();
    expectExpiredSessionCookie(response);
  });

  it('lock release failure never suppresses cookie expiry', async () => {
    const { store } = makeStore({ alice: session() });
    (store.releaseRefreshLock as jest.Mock) = jest.fn(async () => {
      throw new Error('release failed');
    });
    const providerLogout = jest.fn(async () => true);
    const response = await postLogoutWith(req('https://app.test'), {
      config,
      sessionId: 'alice',
      store,
      providerLogout,
    });
    expectExpiredSessionCookie(response);
  });

  it('never includes provider bodies, endpoints, tokens, or exception details in the response JSON', async () => {
    const { store } = makeStore({ alice: session('super-secret-refresh-token') });
    const providerLogout = jest.fn(async () => {
      throw new Error(
        'leaked-access-token-abc123 at https://id.test/realms/x/protocol/openid-connect/logout',
      );
    });
    const response = await postLogoutWith(req('https://app.test'), {
      config,
      sessionId: 'alice',
      store,
      providerLogout,
    });
    const text = JSON.stringify(await response.clone().json());
    expect(text).not.toContain('super-secret-refresh-token');
    expect(text).not.toContain('leaked-access-token-abc123');
    expect(text).not.toContain('id.test');
    expect(text).toBe(JSON.stringify({ outcome: 'unconfirmed' }));
  });
});

/**
 * Keycloak 26 proof (owned scratch realm): a POST to `${backchannelUrl}/protocol/
 * openid-connect/logout` with client_id + refresh_token returns exactly 204 for both a
 * live session and one already terminated by a prior call with the same token — any
 * other status is a non-confirmation. This locks in the exact request shape that was
 * proven against a real Keycloak 26 instance.
 */
describe('defaultProviderLogout request shape', () => {
  const realConfig: AuthConfig = {
    issuer: 'https://id.test/realms/kemfai',
    backchannelUrl: 'https://id.test/realms/kemfai',
    jwksUri: 'https://id.test/realms/kemfai/protocol/openid-connect/certs',
    clientId: 'kemfai-web',
    redirectUri: 'https://app.test/auth/callback',
    apiUrl: 'https://api.test',
    redisUrl: 'redis://test',
  };

  it('POSTs client_id + refresh_token as a form body, no-store, redirect:error, and treats 204 as confirmed', async () => {
    const fetchMock = jest.fn(
      async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    (global.fetch as unknown) = fetchMock;

    const confirmed = await defaultProviderLogout('the-refresh-token', realConfig);

    expect(confirmed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://id.test/realms/kemfai/protocol/openid-connect/logout');
    expect(init.method).toBe('POST');
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('error');
    expect(String(init.body)).toBe('client_id=kemfai-web&refresh_token=the-refresh-token');
  });

  it('treats a non-204 response (e.g. 400 invalid_grant) as unconfirmed, not success', async () => {
    (global.fetch as unknown) = jest.fn(
      async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    );
    await expect(defaultProviderLogout('bad-token', realConfig)).resolves.toBe(false);
  });

  it('treats a 200 response (e.g. the HTML confirm-logout page) as unconfirmed, never guessed as success', async () => {
    (global.fetch as unknown) = jest.fn(
      async () => new Response('<html>confirm logout</html>', { status: 200 }),
    );
    await expect(defaultProviderLogout('some-token', realConfig)).resolves.toBe(false);
  });
});
