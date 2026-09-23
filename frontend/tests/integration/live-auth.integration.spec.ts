/** @jest-environment node */
import { postMfaWith } from '../../src/lib/auth/mfa-bff';
import { exchangeCode } from '../../src/lib/auth/oauth';
import { createPkce, randomOpaque } from '../../src/lib/auth/pkce';
import { closeRedisSessionStoreConnection, RedisSessionStore } from '../../src/lib/auth/session-store';
import type { AuthConfig } from '../../src/lib/auth/config';

const enabled = process.env.LIVE_DOCKER_AUTH === '1';
const live = enabled ? describe : describe.skip;

function cookiesFrom(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

live('live Docker Keycloak + Redis OIDC integration', () => {
  const issuer = process.env.LIVE_KEYCLOAK_ISSUER ?? 'http://localhost:8080/realms/kemfai-customers';
  const config: AuthConfig = {
    issuer,
    backchannelUrl: issuer,
    jwksUri: `${issuer}/protocol/openid-connect/certs`,
    clientId: 'kemfai-api',
    redirectUri: 'http://localhost:3010/auth/callback',
    apiUrl: process.env.LIVE_API_URL ?? 'http://localhost:4000',
    redisUrl: process.env.LIVE_REDIS_URL ?? 'redis://localhost:6379',
  };
  const username = `t039-live-${Date.now()}@example.test`;
  const password = `T039-${randomOpaque(16)}!aA1`;
  let adminToken = '';
  let userId = '';

  beforeAll(async () => {
    const admin = await fetch('http://localhost:8080/realms/master/protocol/openid-connect/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin',
        password: 'kemfai_dev_admin' }),
    });
    expect(admin.ok).toBe(true);
    adminToken = (await admin.json() as { access_token: string }).access_token;
    const created = await fetch('http://localhost:8080/admin/realms/kemfai-customers/users', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ username, email: username, firstName: 'T039', lastName: 'Integration',
        enabled: true, emailVerified: true, requiredActions: [],
        credentials: [{ type: 'password', value: password, temporary: false }] }),
    });
    expect(created.status).toBe(201);
    userId = created.headers.get('location')!.split('/').pop()!;
    const normalized = await fetch(`http://localhost:8080/admin/realms/kemfai-customers/users/${userId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ emailVerified: true, requiredActions: [] }),
    });
    expect(normalized.status).toBe(204);
  });

  afterAll(async () => {
    if (userId) await fetch(`http://localhost:8080/admin/realms/kemfai-customers/users/${userId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` },
    });
    await closeRedisSessionStoreConnection();
  });

  it('executes PKCE, token exchange, JWKS verification, Redis session, and BFF bearer auth', async () => {
    const { verifier, challenge } = createPkce();
    const nonce = randomOpaque();
    const state = randomOpaque();
    const authorization = new URL(`${issuer}/protocol/openid-connect/auth`);
    authorization.search = new URLSearchParams({ client_id: config.clientId,
      redirect_uri: config.redirectUri, response_type: 'code', scope: 'openid', state, nonce,
      code_challenge: challenge, code_challenge_method: 'S256' }).toString();

    const loginPage = await fetch(authorization, { redirect: 'manual' });
    expect(loginPage.status).toBe(200);
    const html = await loginPage.text();
    const action = html.match(/<form[^>]+action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
    expect(action).toBeTruthy();
    const authenticated = await fetch(action!, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: cookiesFrom(loginPage), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password, credentialId: '' }),
    });
    expect(authenticated.status).toBeGreaterThanOrEqual(300);
    expect(authenticated.status).toBeLessThan(400);
    const callback = new URL(authenticated.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe(config.redirectUri);
    expect(callback.searchParams.get('state')).toBe(state);

    const session = await exchangeCode(config, callback.searchParams.get('code')!, verifier, nonce);
    expect(session.accessToken).toBeTruthy();
    const store = new RedisSessionStore(config.redisUrl);
    const sessionId = await store.create(session);
    expect((await store.get(sessionId))?.refreshToken).toBe(session.refreshToken);

    const response = await postMfaWith(new Request('http://localhost:3010/api/accounts/mfa/enroll', {
      method: 'POST', headers: { origin: 'http://localhost:3010' },
    }), 'enroll', { config, sessionId, store });
    // The ephemeral Keycloak-only user deliberately has no control-plane Account. Reaching this
    // account-linkage rejection proves the live API accepted and decoded the verified bearer.
    expect(await response.json()).toMatchObject({ message: 'No account is linked to the authenticated user' });
    await store.destroy(sessionId);
  }, 30_000);
});
