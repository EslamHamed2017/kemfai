/** @jest-environment node */
import { GET as login } from '../../src/app/auth/login/route';
import { validCallbackParameters } from '../../src/lib/auth/callback-validation';
import { NONCE_COOKIE, STATE_COOKIE, VERIFIER_COOKIE } from '../../src/lib/auth/cookies';

describe('PKCE route cookies and callback state (T039)', () => {
  beforeEach(() => {
    process.env.KEYCLOAK_ISSUER = 'https://id.test/realms/customers';
    process.env.KEYCLOAK_BACKCHANNEL_URL = 'http://keycloak.test/realms/customers';
    process.env.KEYCLOAK_CLIENT_ID = 'client';
    process.env.KEYCLOAK_REDIRECT_URI = 'https://app.test/auth/callback';
    process.env.KEMFAI_API_URL = 'https://api.test';
    process.env.REDIS_URL = 'redis://test';
  });

  it('keeps only fixed internal post-login targets', async () => {
    const safe = await login(new Request('https://app.test/auth/login?returnTo=%2Fmfa'));
    expect(safe.headers.getSetCookie().join('\n')).toContain('__Host-kemfai_oidc_return_to=%2Fmfa');
    const unsafe = await login(new Request('https://app.test/auth/login?returnTo=https%3A%2F%2Fevil.test'));
    expect(unsafe.headers.getSetCookie().join('\n')).toContain('__Host-kemfai_oidc_return_to=%2Fmfa');
  });

  it('sets state, nonce, and verifier only in short-lived secure HttpOnly cookies', async () => {
    const response = await login(new Request('https://app.test/auth/login'));
    const cookies = response.headers.getSetCookie().join('\n');
    for (const name of [STATE_COOKIE, NONCE_COOKIE, VERIFIER_COOKIE]) expect(cookies).toContain(`${name}=`);
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('Secure');
    expect(cookies).toContain('SameSite=lax');
    expect(cookies).toContain('Max-Age=300');
    const location = response.headers.get('location')!;
    expect(location).toContain('code_challenge_method=S256');
    expect(location).not.toContain('verifier');
    expect(location).not.toContain('token');
  });

  it('requires matching state plus code, nonce, and verifier', () => {
    expect(validCallbackParameters('same', 'same', 'code', 'nonce', 'verifier')).toBe(true);
    expect(validCallbackParameters('wrong', 'same', 'code', 'nonce', 'verifier')).toBe(false);
    expect(validCallbackParameters('same', 'same', null, 'nonce', 'verifier')).toBe(false);
  });
});
