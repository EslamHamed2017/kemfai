import { NextResponse } from 'next/server';
import {
  getInternalAuthConfig,
  INTERNAL_NONCE_COOKIE,
  INTERNAL_STATE_COOKIE,
  INTERNAL_VERIFIER_COOKIE,
} from '@/lib/auth/internal-auth';
import { createPkce, randomOpaque } from '@/lib/auth/pkce';
import { secureCookie, TRANSIENT_COOKIE_MAX_AGE } from '@/lib/auth/cookies';

export async function GET(): Promise<NextResponse> {
  const config = getInternalAuthConfig();
  const state = randomOpaque();
  const nonce = randomOpaque();
  const { verifier, challenge } = createPkce();
  const authorize = new URL(`${config.issuer}/protocol/openid-connect/auth`);
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  const response = NextResponse.redirect(authorize);
  const options = { ...secureCookie, maxAge: TRANSIENT_COOKIE_MAX_AGE };
  response.cookies.set(INTERNAL_STATE_COOKIE, state, options);
  response.cookies.set(INTERNAL_NONCE_COOKIE, nonce, options);
  response.cookies.set(INTERNAL_VERIFIER_COOKIE, verifier, options);
  return response;
}
