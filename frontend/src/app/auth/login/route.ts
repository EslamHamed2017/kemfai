import { NextResponse } from 'next/server';
import { getAuthConfig } from '@/lib/auth/config';
import {
  NONCE_COOKIE, RETURN_TO_COOKIE, secureCookie, STATE_COOKIE, TRANSIENT_COOKIE_MAX_AGE, VERIFIER_COOKIE,
} from '@/lib/auth/cookies';
import { createPkce, randomOpaque } from '@/lib/auth/pkce';
import { safePostLoginTarget } from '@/lib/auth/return-target';

export async function GET(request: Request): Promise<NextResponse> {
  const config = getAuthConfig();
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
  response.cookies.set(STATE_COOKIE, state, options);
  response.cookies.set(NONCE_COOKIE, nonce, options);
  response.cookies.set(VERIFIER_COOKIE, verifier, options);
  const requestedTarget = new URL(request.url).searchParams.get('returnTo');
  response.cookies.set(RETURN_TO_COOKIE, safePostLoginTarget(requestedTarget), options);
  return response;
}
