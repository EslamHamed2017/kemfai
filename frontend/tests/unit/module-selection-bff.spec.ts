/** @jest-environment node */
import { getModulesWith, putModuleSelectionWith } from '@/lib/auth/module-selection-bff';
import type { AuthConfig } from '@/lib/auth/config';
import type { SessionStore } from '@/lib/auth/session-store';

const config: AuthConfig = {
  issuer: 'https://id.example.test/realms/kemfai',
  backchannelUrl: 'https://id-internal.example.test/realms/kemfai',
  jwksUri: 'https://id-internal.example.test/realms/kemfai/certs',
  clientId: 'frontend',
  redirectUri: 'https://app.example.test/auth/callback',
  apiUrl: 'https://api.example.test',
  redisUrl: 'redis://127.0.0.1:6379',
};

const session = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  accessExpiresAt: Date.now() + 60_000,
  refreshExpiresAt: Date.now() + 120_000,
};

function store(): SessionStore {
  return {
    create: jest.fn(async () => 'private-session'),
    get: jest.fn(async () => session),
    tryAcquireRefreshLock: jest.fn(async () => true),
    releaseRefreshLock: jest.fn(async () => undefined),
    rotateIfCurrent: jest.fn(async () => true),
    destroyIfCurrent: jest.fn(async () => true),
    destroy: jest.fn(async () => undefined),
  };
}

describe('module selection BFF', () => {
  it('forwards authenticated GET without exposing the session or caching', async () => {
    const fetcher = jest.fn(async () =>
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const response = await getModulesWith({ config, sessionId: 'private-session', store: store(), fetcher });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example.test/modules',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        headers: expect.objectContaining({ authorization: 'Bearer access-token' }),
      }),
    );
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('private-session');
  });

  it('rejects cross-origin PUT before authentication or upstream access', async () => {
    const fetcher = jest.fn();
    const sessionStore = store();
    const request = new Request('https://app.example.test/api/modules/selection', {
      method: 'PUT',
      headers: { origin: 'https://evil.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ featureKeys: ['module.accounting'] }),
    });
    const response = await putModuleSelectionWith(request, ['module.accounting'], {
      config,
      sessionId: 'private-session',
      store: sessionStore,
      fetcher,
    });

    expect(response.status).toBe(403);
    expect(sessionStore.get).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds and validates feature keys before forwarding same-origin PUT', async () => {
    const fetcher = jest.fn(async () =>
      new Response('{"featureKeys":["module.accounting"]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const request = new Request('https://app.example.test/api/modules/selection', {
      method: 'PUT',
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
    });
    const response = await putModuleSelectionWith(request, ['module.accounting'], {
      config,
      sessionId: 'private-session',
      store: store(),
      fetcher,
    });

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example.test/modules/selection',
      expect.objectContaining({ method: 'PUT', body: '{"featureKeys":["module.accounting"]}' }),
    );
  });

  it('rejects invalid or excessive keys without calling upstream', async () => {
    const fetcher = jest.fn();
    const request = new Request('https://app.example.test/api/modules/selection', {
      method: 'PUT',
      headers: { origin: 'https://app.example.test' },
    });
    for (const featureKeys of [['invalid key'], Array.from({ length: 101 }, (_, index) => `module.m${index}`)]) {
      const response = await putModuleSelectionWith(request, featureKeys, {
        config,
        sessionId: 'private-session',
        store: store(),
        fetcher,
      });
      expect(response.status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
