/** @jest-environment node */
import type { AuthConfig } from '../../src/lib/auth/config';
import { postInternalLogoutWith } from '../../src/lib/auth/internal-logout-bff';
import type { SessionStore, StoredSession } from '../../src/lib/auth/session-store';

const config: AuthConfig = {
  issuer: 'https://id.test/realms/internal',
  backchannelUrl: 'https://id.test/realms/internal',
  jwksUri: 'https://id.test/certs',
  clientId: 'internal',
  redirectUri: 'https://app.test/internal-auth/callback',
  apiUrl: 'https://api.test',
  redisUrl: 'redis://test',
};
const value = (refreshToken: string): StoredSession => ({
  accessToken: 'access',
  refreshToken,
  accessExpiresAt: Date.now() + 1000,
  refreshExpiresAt: Date.now() + 10000,
});
const request = () =>
  new Request('https://app.test/api/internal/auth/logout', {
    method: 'POST',
    headers: { origin: 'https://app.test' },
  });

function fixture(current = value('old')) {
  let session: StoredSession | null = current;
  let locked = false;
  const store: SessionStore = {
    create: async () => 'id',
    get: async () => session,
    tryAcquireRefreshLock: async () => {
      if (locked) return false;
      locked = true;
      return true;
    },
    releaseRefreshLock: async () => {
      locked = false;
    },
    rotateIfCurrent: async (_id, token, next) => {
      if (session?.refreshToken !== token) return false;
      session = next;
      return true;
    },
    destroyIfCurrent: async (_id, token) => {
      if (session?.refreshToken !== token) return false;
      session = null;
      return true;
    },
    destroy: async () => {
      session = null;
    },
  };
  return {
    store,
    current: () => session,
    rotate: (next: StoredSession) => {
      session = next;
    },
  };
}

test('holds the shared refresh lock through provider revoke and CAS deletion', async () => {
  const f = fixture();
  let rotateWhileLocked = true;
  const provider = jest.fn(async (token: string) => {
    rotateWhileLocked = await f.store.tryAcquireRefreshLock('id', 'refresh', 1000);
    return token === 'old';
  });
  const response = await postInternalLogoutWith(request(), {
    config,
    sessionId: 'id',
    store: f.store,
    providerLogout: provider,
  });
  expect(rotateWhileLocked).toBe(false);
  expect(response.status).toBe(200);
  expect(f.current()).toBeNull();
});
test('never confirms or deletes a newer rotated session when CAS reports stale', async () => {
  const f = fixture();
  f.store.destroyIfCurrent = jest.fn(async () => {
    f.rotate(value('rotated'));
    return false;
  });
  const response = await postInternalLogoutWith(request(), {
    config,
    sessionId: 'id',
    store: f.store,
    providerLogout: async () => true,
  });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ outcome: 'unconfirmed' });
  expect(f.current()?.refreshToken).toBe('rotated');
});
test('lock contention never calls provider, reports unconfirmed, and does not delete an unknown current token', async () => {
  const f = fixture(value('rotated'));
  f.store.tryAcquireRefreshLock = async () => false;
  const provider = jest.fn();
  const response = await postInternalLogoutWith(request(), {
    config,
    sessionId: 'id',
    store: f.store,
    providerLogout: provider,
  });
  expect(response.status).toBe(502);
  expect(provider).not.toHaveBeenCalled();
  expect(f.current()?.refreshToken).toBe('rotated');
});
test('provider failure removes only the token read under lock and remains unconfirmed', async () => {
  const f = fixture();
  const response = await postInternalLogoutWith(request(), {
    config,
    sessionId: 'id',
    store: f.store,
    providerLogout: async () => false,
  });
  expect(response.status).toBe(502);
  expect(f.current()).toBeNull();
});
test('always releases an acquired refresh lock and expires only the internal cookie', async () => {
  const f = fixture();
  const release = jest.spyOn(f.store, 'releaseRefreshLock');
  const response = await postInternalLogoutWith(request(), {
    config,
    sessionId: 'id',
    store: f.store,
    providerLogout: async () => true,
  });
  expect(release).toHaveBeenCalledTimes(1);
  const cookie = response.headers.get('set-cookie') ?? '';
  expect(cookie).toContain('__Host-kemfai_internal_session=');
  expect(cookie).not.toContain('__Host-kemfai_session=');
});
