/** @jest-environment node */
import { patchLocaleWith, getLocaleWith } from '../../src/lib/auth/locale-bff';
import { exchangeCode } from '../../src/lib/auth/oauth';
import { createPkce, randomOpaque } from '../../src/lib/auth/pkce';
import { closeRedisSessionStoreConnection, RedisSessionStore } from '../../src/lib/auth/session-store';
import type { AuthConfig } from '../../src/lib/auth/config';

const enabled = process.env.LIVE_DOCKER_AUTH === '1';
const live = enabled ? describe : describe.skip;

function cookiesFrom(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

/**
 * T103 live integration — the FULL production chain with a REAL login, twice:
 *
 *   1. Create a real Keycloak user WITH a real control-plane Account row (the T039
 *      sibling deliberately has no Account; here persistence needs the row).
 *   2. Login #1 through the REAL Keycloak OIDC dance (PKCE + code exchange + Redis
 *      session) → PATCH ar through the real BFF function → REAL 200.
 *   3. Destroy the session (logout), login #2 from scratch → GET through the real BFF
 *      → the FRESH session reads back `ar` — persistence across sessions, proven on
 *      the production authentication flow (the exact T103 acceptance criterion).
 */

live('live Keycloak + Redis + API locale persistence (T103)', () => {
  const issuer = process.env.LIVE_KEYCLOAK_ISSUER ?? 'http://localhost:8080/realms/kemfai-customers';
  const apiUrl = process.env.LIVE_API_URL ?? 'http://localhost:4000';
  const config: AuthConfig = {
    issuer,
    backchannelUrl: issuer,
    jwksUri: `${issuer}/protocol/openid-connect/certs`,
    clientId: 'kemfai-api',
    redirectUri: 'http://localhost:3010/auth/callback',
    apiUrl,
    redisUrl: process.env.LIVE_REDIS_URL ?? 'redis://localhost:6379',
  };
  const username = `t103-live-${Date.now()}@example.test`;
  const password = `T103-${randomOpaque(16)}!aA1`;
  let adminToken = '';
  let userId = '';
  let keycloakUserId = '';

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
      body: JSON.stringify({ username, email: username, firstName: 'T103', lastName: 'Persistence',
        enabled: true, emailVerified: true, requiredActions: [],
        credentials: [{ type: 'password', value: password, temporary: false }] }),
    });
    expect(created.status).toBe(201);
    userId = created.headers.get('location')!.split('/').pop()!;
    await fetch(`http://localhost:8080/admin/realms/kemfai-customers/users/${userId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ emailVerified: true, requiredActions: [] }),
    });

    // The control-plane Account row the preference persists on. The live API container
    // intentionally runs WITHOUT Keycloak admin credentials (T025 hardening — signup's
    // provisioning path needs them), so the row is planted through the same dev-DB
    // channel the T039 script uses (docker exec psql); the test's subject is the locale
    // behavior, not the signup flow.
    const { execFileSync } = require('node:child_process');
    execFileSync('sudo', ['-n', 'docker', 'exec', 'kemfai-db', 'psql', '-U', 'odoo', '-d',
      'kemfai_control', '-v', 'ON_ERROR_STOP=1', '-c',
      `insert into account (keycloak_user_id, email, email_verified, mfa_enrolled) values ('${userId}', '${username}', true, false)`],
      { stdio: 'pipe' });
    keycloakUserId = userId;
  }, 60_000);

  afterAll(async () => {
    if (userId) {
      await fetch(`http://localhost:8080/admin/realms/kemfai-customers/users/${userId}`, {
        method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` },
      });
    }
    await closeRedisSessionStoreConnection();
  }, 60_000);

  async function realLogin(): Promise<{ sessionId: string; store: RedisSessionStore }> {
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
    const session = await exchangeCode(config, callback.searchParams.get('code')!, verifier, nonce);
    expect(session.accessToken).toBeTruthy();
    const store = new RedisSessionStore(config.redisUrl);
    const sessionId = await store.create(session);
    return { sessionId, store };
  }

  it('persists locale across TWO independent real login sessions', async () => {
    // ---- Login #1: choose Arabic through the real BFF ----
    const first = await realLogin();
    const patchResponse = await patchLocaleWith(new Request('http://localhost:3010/api/accounts/me/locale', {
      method: 'PATCH',
      headers: { origin: 'http://localhost:3010', 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'ar' }),
    }), { config, sessionId: first.sessionId, store: first.store });
    expect(patchResponse.status).toBe(200);
    await first.store.destroy(first.sessionId); // logout — session gone

    // ---- Login #2: completely fresh OIDC dance; the preference must follow ----
    const second = await realLogin();
    const getResponse = await getLocaleWith({ config, sessionId: second.sessionId, store: second.store });
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({ locale: 'ar' });
    await second.store.destroy(second.sessionId);
  }, 120_000);
});
