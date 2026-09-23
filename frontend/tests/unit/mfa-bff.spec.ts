/** @jest-environment node */
import type { AuthConfig } from '../../src/lib/auth/config';
import { postMfaWith } from '../../src/lib/auth/mfa-bff';
import type { SessionStore, StoredSession } from '../../src/lib/auth/session-store';

const config: AuthConfig = { issuer: 'https://id.test', backchannelUrl: 'https://id.test',
  jwksUri: 'https://id.test/certs',
  clientId: 'client', redirectUri: 'https://app.test/auth/callback', apiUrl: 'https://api.test',
  redisUrl: 'redis://test' };
const valid: StoredSession = { accessToken: 'server-only-bearer', refreshToken: 'server-only-refresh',
  accessExpiresAt: Date.now() + 60_000, refreshExpiresAt: Date.now() + 120_000 };
const store = (value: StoredSession | null): SessionStore => ({
  create: async () => 'id', get: async () => value,
  tryAcquireRefreshLock: async () => true, releaseRefreshLock: async () => undefined,
  rotateIfCurrent: async () => true, destroyIfCurrent: async () => true,
  destroy: async () => undefined,
});
const request = (origin = 'https://app.test') => new Request('https://app.test/api/accounts/mfa/enroll', {
  method: 'POST', headers: { origin },
});

describe('narrow MFA BFF', () => {
  it('rejects CSRF before any upstream call', async () => {
    const fetcher = jest.fn();
    const response = await postMfaWith(request('https://evil.test'), 'enroll', {
      config, sessionId: 'opaque', store: store(valid), fetcher,
    });
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns 401 without a valid server-side session', async () => {
    const response = await postMfaWith(request(), 'enroll', {
      config, sessionId: undefined, store: store(null), fetcher: jest.fn(),
    });
    expect(response.status).toBe(401);
  });

  it.each(['enroll', 'confirm'] as const)('injects bearer for only fixed %s endpoint', async (operation) => {
    const fetcher = jest.fn().mockResolvedValue(new Response('{"ok":true}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const response = await postMfaWith(request(), operation, {
      config, sessionId: 'opaque', store: store(valid), fetcher,
    });
    expect(fetcher).toHaveBeenCalledWith(`https://api.test/accounts/mfa/${operation}`,
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer server-only-bearer' }) }));
    expect(await response.text()).not.toContain('server-only');
  });
});
