import type { NextResponse } from 'next/server';

export const SESSION_COOKIE = '__Host-kemfai_session';
export const STATE_COOKIE = '__Host-kemfai_oidc_state';
export const NONCE_COOKIE = '__Host-kemfai_oidc_nonce';
export const VERIFIER_COOKIE = '__Host-kemfai_pkce_verifier';
export const RETURN_TO_COOKIE = '__Host-kemfai_oidc_return_to';

export const secureCookie = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
};

export const TRANSIENT_COOKIE_MAX_AGE = 300;

/**
 * `response.cookies.delete(SESSION_COOKIE)` only sets `Path=/`; it never carries
 * `Secure`, which a `__Host-`-prefixed cookie's Set-Cookie attributes MUST have or the
 * browser rejects the whole header and leaves the original (still-Secure) cookie
 * untouched — silently failing to expire it. Setting the same `secureCookie` shape used
 * at login, with `maxAge: 0`, is what actually overwrites/expires it.
 */
export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, '', { ...secureCookie, maxAge: 0 });
}
