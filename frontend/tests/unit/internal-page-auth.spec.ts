/** @jest-environment node */
import type { AuthConfig } from '../../src/lib/auth/config';
import { hasAuthenticatedInternalSession } from '../../src/lib/auth/internal-page-auth';
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
const session: StoredSession = {
  accessToken: 'token',
  refreshToken: 'refresh',
  accessExpiresAt: Date.now() + 3600000,
  refreshExpiresAt: Date.now() + 7200000,
};
const store = (stored: StoredSession | null): SessionStore => ({
  create: async () => 'id',
  get: async () => stored,
  tryAcquireRefreshLock: async () => true,
  releaseRefreshLock: async () => undefined,
  rotateIfCurrent: async () => true,
  destroyIfCurrent: async () => true,
  destroy: async () => undefined,
});

test('fails closed before rendering the internal page without a server session', async () => {
  expect(await hasAuthenticatedInternalSession(undefined, config, store(session))).toBe(false);
});
test('rejects a forged cookie whose Redis session does not exist', async () => {
  expect(await hasAuthenticatedInternalSession('forged', config, store(null))).toBe(false);
});
test('accepts only a server-held usable internal session', async () => {
  expect(await hasAuthenticatedInternalSession('real', config, store(session))).toBe(true);
});
