/** @jest-environment node */
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { accessTokenForSession } from '../../src/lib/auth/authenticated-session';
import type { AuthConfig } from '../../src/lib/auth/config';
import { SESSION_COOKIE, secureCookie } from '../../src/lib/auth/cookies';
import { exchangeCode } from '../../src/lib/auth/oauth';
import { hasSameOrigin } from '../../src/lib/auth/origin';
import { constantTimeEqual, createPkce, randomOpaque } from '../../src/lib/auth/pkce';
import type { SessionStore, StoredSession } from '../../src/lib/auth/session-store';

let privateKey: KeyLike;
let otherPrivateKey: KeyLike;
let jwksServer: Server;
let jwksUri: string;

const baseConfig = {
  issuer: 'https://id.example.test/realms/customers',
  backchannelUrl: 'https://id-internal.example.test/realms/customers',
  clientId: 'client', redirectUri: 'https://app.example.test/auth/callback',
  apiUrl: 'https://api.example.test', redisUrl: 'redis://redis.test',
};
let config: AuthConfig;

async function idToken(overrides: {
  key?: KeyLike; issuer?: string; audience?: string; nonce?: string; expiresIn?: string;
  azp?: string;
} = {}): Promise<string> {
  return new SignJWT({ nonce: overrides.nonce ?? 'expected', azp: overrides.azp ?? 'client' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(overrides.issuer ?? config.issuer)
    .setAudience(overrides.audience ?? config.clientId)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '5m')
    .sign(overrides.key ?? privateKey);
}

function unsignedJwt(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ iss: config.issuer, aud: config.clientId,
    nonce: 'expected', exp: Math.floor(Date.now() / 1000) + 300 })}.`;
}

function tokenResponse(token: string) {
  return new Response(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret',
    expires_in: 60, refresh_expires_in: 300, id_token: token }), { status: 200 });
}

class MemoryStore implements SessionStore {
  value: StoredSession | null;
  lockOwner?: string;
  destroyed = false;
  constructor(value: StoredSession | null) { this.value = value; }
  async create(value: StoredSession) { this.value = value; return randomOpaque(); }
  async get() { return this.value; }
  async tryAcquireRefreshLock(_id: string, owner: string) {
    if (this.lockOwner) return false;
    this.lockOwner = owner;
    return true;
  }
  async releaseRefreshLock(_id: string, owner: string) {
    if (this.lockOwner === owner) this.lockOwner = undefined;
  }
  async rotateIfCurrent(_id: string, refreshToken: string, value: StoredSession) {
    if (this.value?.refreshToken !== refreshToken) return false;
    this.value = value;
    return true;
  }
  async destroyIfCurrent(_id: string, refreshToken: string) {
    if (this.value?.refreshToken !== refreshToken) return false;
    this.destroyed = true;
    this.value = null;
    return true;
  }
  async destroy() { this.destroyed = true; this.value = null; }
}

describe('T039 authentication foundation', () => {
  beforeAll(async () => {
    ({ privateKey: otherPrivateKey } = await generateKeyPair('RS256'));
    const generated = await generateKeyPair('RS256');
    privateKey = generated.privateKey;
    const jwk = await exportJWK(generated.publicKey);
    Object.assign(jwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });
    jwksServer = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
    const address = jwksServer.address();
    if (!address || typeof address === 'string') throw new Error('JWKS server did not start');
    jwksUri = `http://127.0.0.1:${address.port}/certs`;
    config = { ...baseConfig, jwksUri };
  });

  afterAll(async () => new Promise<void>((resolve, reject) => jwksServer.close((error) => error ? reject(error) : resolve())));
  afterEach(() => jest.restoreAllMocks());

  it('generates S256 PKCE and unpredictable opaque values', () => {
    const first = createPkce();
    const second = createPkce();
    expect(first.verifier).toHaveLength(86);
    expect(first.challenge).toHaveLength(43);
    expect(first).not.toEqual(second);
    expect(constantTimeEqual(first.verifier, first.verifier)).toBe(true);
    expect(constantTimeEqual(first.verifier, second.verifier)).toBe(false);
  });

  it('exchanges the code with PKCE and accepts only a verified ID token', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(tokenResponse(await idToken()));
    await expect(exchangeCode(config, 'authorization-code', 'verifier', 'expected'))
      .resolves.toMatchObject({ accessToken: 'access-secret' });
    const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get('code_verifier')).toBe('verifier');
  });

  it.each([
    ['unsigned', async () => unsignedJwt()],
    ['wrong signature', async () => idToken({ key: otherPrivateKey })],
    ['wrong issuer', async () => idToken({ issuer: 'https://evil.test/realms/customers' })],
    ['wrong audience', async () => idToken({ audience: 'other-client' })],
    ['wrong authorized party', async () => idToken({ azp: 'other-client' })],
    ['expired', async () => idToken({ expiresIn: '-10s' })],
    ['wrong nonce', async () => idToken({ nonce: 'wrong' })],
  ])('rejects an ID token that is %s', async (_case, makeToken) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(tokenResponse(await makeToken()));
    await expect(exchangeCode(config, 'code', 'verifier', 'expected')).rejects.toThrow();
  });

  it('serializes true concurrent refresh calls and uses the single rotated result', async () => {
    const store = new MemoryStore({ accessToken: 'old-a', refreshToken: 'old-r',
      accessExpiresAt: 0, refreshExpiresAt: Date.now() + 60_000 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      await gate;
      return new Response(JSON.stringify({ access_token: 'new-a', refresh_token: 'new-r',
        expires_in: 60, refresh_expires_in: 120 }), { status: 200 });
    });
    const first = accessTokenForSession('opaque-id', config, store);
    const second = accessTokenForSession('opaque-id', config, store);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['new-a', 'new-a']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cannot delete a newer rotated session after a stale refresh failure', async () => {
    const stale = { accessToken: 'old-a', refreshToken: 'old-r', accessExpiresAt: 0,
      refreshExpiresAt: Date.now() + 60_000 };
    const store = new MemoryStore(stale);
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      store.value = { ...stale, accessToken: 'new-a', refreshToken: 'new-r',
        accessExpiresAt: Date.now() + 60_000 };
      return new Response('', { status: 401 });
    });
    await expect(accessTokenForSession('opaque-id', config, store)).resolves.toBeNull();
    expect(store.value?.refreshToken).toBe('new-r');
  });

  it('requires the exact same Origin and defines a secure opaque session cookie', () => {
    const same = new Request('https://app.example.test/api/accounts/mfa/enroll', {
      method: 'POST', headers: { origin: 'https://app.example.test' },
    });
    const cross = new Request('https://app.example.test/api/accounts/mfa/enroll', {
      method: 'POST', headers: { origin: 'https://evil.example' },
    });
    expect(hasSameOrigin(same, config.redirectUri)).toBe(true);
    expect(hasSameOrigin(cross, config.redirectUri)).toBe(false);
    expect(SESSION_COOKIE).toBe('__Host-kemfai_session');
    expect(secureCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  });
});
