import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { validCallbackParameters } from '@/lib/auth/callback-validation';
import { secureCookie } from '@/lib/auth/cookies';
import {
  getInternalAuthConfig,
  INTERNAL_NONCE_COOKIE,
  INTERNAL_SESSION_COOKIE,
  INTERNAL_STATE_COOKIE,
  INTERNAL_VERIFIER_COOKIE,
} from '@/lib/auth/internal-auth';
import { exchangeCode } from '@/lib/auth/oauth';
import { RedisSessionStore } from '@/lib/auth/session-store';

export async function GET(request: Request): Promise<NextResponse> {
  const config = getInternalAuthConfig();
  const jar = await cookies();
  const url = new URL(request.url);
  const state = jar.get(INTERNAL_STATE_COOKIE)?.value,
    nonce = jar.get(INTERNAL_NONCE_COOKIE)?.value,
    verifier = jar.get(INTERNAL_VERIFIER_COOKIE)?.value,
    code = url.searchParams.get('code');
  const clear = (r: NextResponse) => {
    for (const name of [INTERNAL_STATE_COOKIE, INTERNAL_NONCE_COOKIE, INTERNAL_VERIFIER_COOKIE])
      r.cookies.delete(name);
  };
  if (!validCallbackParameters(url.searchParams.get('state'), state, code, nonce, verifier)) {
    const r = NextResponse.redirect(new URL('/internal-auth/login', config.redirectUri));
    clear(r);
    return r;
  }
  try {
    const session = await exchangeCode(config, code!, verifier!, nonce!);
    const id = await new RedisSessionStore(config.redisUrl).create(session);
    const r = NextResponse.redirect(new URL('/billing-review', config.redirectUri));
    r.cookies.set(INTERNAL_SESSION_COOKIE, id, {
      ...secureCookie,
      maxAge: Math.max(1, Math.floor((session.refreshExpiresAt - Date.now()) / 1000)),
    });
    clear(r);
    return r;
  } catch {
    const r = NextResponse.redirect(new URL('/internal-auth/login', config.redirectUri));
    clear(r);
    return r;
  }
}
