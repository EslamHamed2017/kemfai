import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { validCallbackParameters } from '@/lib/auth/callback-validation';
import { getAuthConfig } from '@/lib/auth/config';
import {
  NONCE_COOKIE, RETURN_TO_COOKIE, secureCookie, SESSION_COOKIE, STATE_COOKIE, VERIFIER_COOKIE,
} from '@/lib/auth/cookies';
import { exchangeCode } from '@/lib/auth/oauth';
import { RedisSessionStore } from '@/lib/auth/session-store';
import { safePostLoginTarget } from '@/lib/auth/return-target';

function clearTransient(response: NextResponse): void {
  for (const name of [STATE_COOKIE, NONCE_COOKIE, VERIFIER_COOKIE, RETURN_TO_COOKIE]) response.cookies.delete(name);
}

export async function GET(request: Request): Promise<NextResponse> {
  const config = getAuthConfig();
  const url = new URL(request.url);
  const jar = await cookies();
  const state = jar.get(STATE_COOKIE)?.value;
  const nonce = jar.get(NONCE_COOKIE)?.value;
  const verifier = jar.get(VERIFIER_COOKIE)?.value;
  const returnTo = safePostLoginTarget(jar.get(RETURN_TO_COOKIE)?.value);
  const code = url.searchParams.get('code');

  if (!validCallbackParameters(url.searchParams.get('state'), state, code, nonce, verifier)) {
    const failed = NextResponse.redirect(new URL('/auth/login', config.redirectUri));
    clearTransient(failed);
    return failed;
  }

  try {
    const session = await exchangeCode(config, code!, verifier!, nonce!);
    const id = await new RedisSessionStore(config.redisUrl).create(session);
    // The marker carries no credential; it only restores the MFA UI step after Keycloak's
    // hosted CONFIGURE_TOTP action. Codes/tokens are never forwarded into this URL.
    const response = NextResponse.redirect(new URL(returnTo, config.redirectUri));
    response.cookies.set(SESSION_COOKIE, id, {
      ...secureCookie,
      maxAge: Math.max(1, Math.floor((session.refreshExpiresAt - Date.now()) / 1000)),
    });
    clearTransient(response);
    return response;
  } catch {
    const failed = NextResponse.redirect(new URL('/auth/login', config.redirectUri));
    clearTransient(failed);
    return failed;
  }
}
