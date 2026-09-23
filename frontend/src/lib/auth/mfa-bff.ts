import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { accessTokenForSession } from './authenticated-session';
import { getAuthConfig } from './config';
import { SESSION_COOKIE } from './cookies';
import { hasSameOrigin } from './origin';
import { RedisSessionStore, type SessionStore } from './session-store';

export type MfaOperation = 'enroll' | 'confirm';

export interface MfaBffDependencies {
  config: ReturnType<typeof getAuthConfig>;
  sessionId?: string;
  store: SessionStore;
  fetcher?: typeof fetch;
}

export async function postMfaWith(
  request: Request,
  operation: MfaOperation,
  dependencies: MfaBffDependencies,
): Promise<NextResponse> {
  const { config, sessionId: id, store } = dependencies;
  const fetcher = dependencies.fetcher ?? fetch;
  if (!hasSameOrigin(request, config.redirectUri)) {
    return NextResponse.json({ message: 'Forbidden origin' }, { status: 403 });
  }
  if (!id) return NextResponse.json({ message: 'Authentication required' }, { status: 401 });
  const token = await accessTokenForSession(id, config, store);
  if (!token) {
    const response = NextResponse.json({ message: 'Authentication required' }, { status: 401 });
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }
  const upstream = await fetcher(`${config.apiUrl}/accounts/mfa/${operation}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    cache: 'no-store',
  });
  const text = await upstream.text();
  return new NextResponse(text || null, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

/** Fixed operation union intentionally prevents this handler becoming an open proxy. */
export async function postMfa(request: Request, operation: MfaOperation): Promise<NextResponse> {
  const config = getAuthConfig();
  const id = (await cookies()).get(SESSION_COOKIE)?.value;
  const store = new RedisSessionStore(config.redisUrl);
  return postMfaWith(request, operation, { config, sessionId: id, store });
}
