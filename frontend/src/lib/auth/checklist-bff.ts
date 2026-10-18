import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { accessTokenForSession } from './authenticated-session';
import { getAuthConfig, type AuthConfig } from './config';
import { clearSessionCookie, SESSION_COOKIE } from './cookies';
import { RedisSessionStore, type SessionStore } from './session-store';

interface Dependencies {
  config: AuthConfig;
  sessionId?: string;
  store: SessionStore;
  fetcher?: typeof fetch;
}

export async function getChecklistWith(deps: Dependencies): Promise<NextResponse> {
  if (!deps.sessionId)
    return NextResponse.json({ message: 'Authentication required' }, { status: 401 });
  const token = await accessTokenForSession(deps.sessionId, deps.config, deps.store);
  if (!token) {
    const response = NextResponse.json({ message: 'Authentication required' }, { status: 401 });
    clearSessionCookie(response);
    return response;
  }
  try {
    const upstream = await (deps.fetcher ?? fetch)(`${deps.config.apiUrl}/onboarding/checklist`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (upstream.status === 401) {
      const response = NextResponse.json({ message: 'Authentication required' }, { status: 401 });
      clearSessionCookie(response);
      return response;
    }
    return new NextResponse((await upstream.text()) || null, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ message: 'Checklist is temporarily unavailable' }, { status: 502 });
  }
}

export async function getChecklist(): Promise<NextResponse> {
  const config = getAuthConfig();
  return getChecklistWith({
    config,
    sessionId: (await cookies()).get(SESSION_COOKIE)?.value,
    store: new RedisSessionStore(config.redisUrl),
  });
}
