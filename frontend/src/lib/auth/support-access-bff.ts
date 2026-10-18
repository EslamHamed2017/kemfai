import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { accessTokenForSession } from './authenticated-session';
import { getAuthConfig, type AuthConfig } from './config';
import { clearSessionCookie, SESSION_COOKIE } from './cookies';
import { hasSameOrigin } from './origin';
import { RedisSessionStore, type SessionStore } from './session-store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface Dependencies {
  config: AuthConfig;
  sessionId?: string;
  store: SessionStore;
  fetcher?: typeof fetch;
}

async function forward(deps: Dependencies, path: string, method: 'GET' | 'POST', body?: unknown) {
  if (!deps.sessionId)
    return NextResponse.json({ message: 'Authentication required' }, { status: 401 });
  const token = await accessTokenForSession(deps.sessionId, deps.config, deps.store);
  if (!token) {
    const response = NextResponse.json({ message: 'Authentication required' }, { status: 401 });
    clearSessionCookie(response);
    return response;
  }
  try {
    const upstream = await (deps.fetcher ?? fetch)(`${deps.config.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
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
    return NextResponse.json(
      { message: 'Support access is temporarily unavailable' },
      { status: 502 },
    );
  }
}

async function dependencies(): Promise<Dependencies> {
  const config = getAuthConfig();
  return {
    config,
    sessionId: (await cookies()).get(SESSION_COOKIE)?.value,
    store: new RedisSessionStore(config.redisUrl),
  };
}
export const getSupportGrantsWith = (deps: Dependencies) =>
  forward(deps, '/support-access/grants', 'GET');
export const getSupportGrants = async () => getSupportGrantsWith(await dependencies());

export async function createSupportGrantWith(
  request: Request,
  expiresAt: unknown,
  deps: Dependencies,
) {
  if (!hasSameOrigin(request, deps.config.redirectUri))
    return NextResponse.json({ message: 'Forbidden origin' }, { status: 403 });
  if (typeof expiresAt !== 'string' || !Number.isFinite(new Date(expiresAt).getTime()))
    return NextResponse.json({ message: 'A valid expiry is required' }, { status: 400 });
  return forward(deps, '/support-access/grants', 'POST', { granteeRole: 'Support', expiresAt });
}
export async function createSupportGrant(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Malformed JSON' }, { status: 400 });
  }
  return createSupportGrantWith(
    request,
    (body as { expiresAt?: unknown } | null)?.expiresAt,
    await dependencies(),
  );
}
export async function revokeSupportGrantWith(
  request: Request,
  grantId: string,
  deps: Dependencies,
) {
  if (!hasSameOrigin(request, deps.config.redirectUri))
    return NextResponse.json({ message: 'Forbidden origin' }, { status: 403 });
  if (!UUID.test(grantId)) return NextResponse.json({ message: 'Invalid grant' }, { status: 400 });
  return forward(deps, `/support-access/grants/${grantId}/revoke`, 'POST');
}
export const revokeSupportGrant = async (request: Request, grantId: string) =>
  revokeSupportGrantWith(request, grantId, await dependencies());
