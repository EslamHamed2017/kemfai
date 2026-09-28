import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { accessTokenForSession } from './authenticated-session';
import { getAuthConfig, type AuthConfig } from './config';
import { SESSION_COOKIE } from './cookies';
import { hasSameOrigin } from './origin';
import { RedisSessionStore, type SessionStore } from './session-store';

export interface LocaleBffDependencies {
  config: AuthConfig;
  sessionId?: string;
  store: SessionStore;
  fetcher?: typeof fetch;
}

async function callApi(
  method: 'GET' | 'PATCH',
  body: { locale: 'en' | 'ar' } | undefined,
  dependencies: LocaleBffDependencies,
): Promise<NextResponse> {
  const { config } = dependencies;
  const fetcher = dependencies.fetcher ?? fetch;
  const { sessionId: id } = dependencies;
  let token: string | null = null;
  if (id) token = await accessTokenForSession(id, config, dependencies.store);
  if (!token) {
    const response = NextResponse.json({ message: 'Authentication required' }, { status: 401 });
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }
  const upstream = await fetcher(`${config.apiUrl}/accounts/me/locale`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await upstream.text();
  return new NextResponse(text || null, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

/**
 * T104 — `GET /api/accounts/me/locale` core (BFF). Explicit-dependency form (the
 * established mfa-bff `postMfaWith` doctrine) so live integration tests exercise the
 * exact production path with a real Keycloak login's session.
 */
export async function getLocaleWith(dependencies: LocaleBffDependencies): Promise<NextResponse> {
  return callApi('GET', undefined, dependencies);
}

/**
 * T104 — `PATCH /api/accounts/me/locale` core (BFF). Fixed to the single upstream path
 * and the T113 contract's JSON body; cannot become an open proxy. Same-origin enforced,
 * body validated to exactly 'en' | 'ar' (422 otherwise), unauthenticated callers get 401.
 */
export async function patchLocaleWith(
  request: Request,
  dependencies: LocaleBffDependencies,
): Promise<NextResponse> {
  if (!hasSameOrigin(request, dependencies.config.redirectUri)) {
    return NextResponse.json({ message: 'Forbidden origin' }, { status: 403 });
  }
  let locale: unknown;
  try {
    locale = (await request.json()).locale;
  } catch {
    return NextResponse.json({ message: 'Malformed JSON body' }, { status: 400 });
  }
  if (locale !== 'en' && locale !== 'ar') {
    return NextResponse.json({ message: 'Unsupported locale' }, { status: 422 });
  }
  return callApi('PATCH', { locale }, dependencies);
}

/** Route wrapper: resolves the session cookie into explicit dependencies. */
export async function getLocaleFromApi(): Promise<NextResponse> {
  const config = getAuthConfig();
  const id = (await cookies()).get(SESSION_COOKIE)?.value;
  return getLocaleWith({ config, sessionId: id, store: new RedisSessionStore(config.redisUrl) });
}

/** Route wrapper: resolves the session cookie into explicit dependencies. */
export async function patchLocale(request: Request): Promise<NextResponse> {
  const config = getAuthConfig();
  const id = (await cookies()).get(SESSION_COOKIE)?.value;
  return patchLocaleWith(request, {
    config,
    sessionId: id,
    store: new RedisSessionStore(config.redisUrl),
  });
}
