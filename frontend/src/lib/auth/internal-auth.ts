import type { NextResponse } from 'next/server';
import type { AuthConfig } from './config';

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/\/$/, '');
};

export const INTERNAL_SESSION_COOKIE = '__Host-kemfai_internal_session';
export const INTERNAL_STATE_COOKIE = '__Host-kemfai_internal_oidc_state';
export const INTERNAL_NONCE_COOKIE = '__Host-kemfai_internal_oidc_nonce';
export const INTERNAL_VERIFIER_COOKIE = '__Host-kemfai_internal_pkce_verifier';

export function getInternalAuthConfig(): AuthConfig {
  const issuer = required('INTERNAL_KEYCLOAK_ISSUER');
  const backchannelUrl = required('INTERNAL_KEYCLOAK_BACKCHANNEL_URL');
  return {
    issuer,
    backchannelUrl,
    jwksUri: (
      process.env.INTERNAL_KEYCLOAK_JWKS_URI?.trim() ||
      `${backchannelUrl}/protocol/openid-connect/certs`
    ).replace(/\/$/, ''),
    clientId: required('INTERNAL_KEYCLOAK_CLIENT_ID'),
    redirectUri: required('INTERNAL_KEYCLOAK_REDIRECT_URI'),
    apiUrl: required('KEMFAI_API_URL'),
    redisUrl: required('REDIS_URL'),
  };
}

export function clearInternalSessionCookie(response: NextResponse): void {
  response.cookies.set(INTERNAL_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
