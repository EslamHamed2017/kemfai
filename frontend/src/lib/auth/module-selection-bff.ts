import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { accessTokenForSession } from './authenticated-session';
import { getAuthConfig, type AuthConfig } from './config';
import { clearSessionCookie, SESSION_COOKIE } from './cookies';
import { hasSameOrigin } from './origin';
import { RedisSessionStore, type SessionStore } from './session-store';

const MAX_FEATURE_KEYS = 100;
const FEATURE_KEY = /^[a-z][a-z0-9_.-]{0,127}$/;

export interface ModuleSelectionBffDependencies {
  config: AuthConfig;
  sessionId?: string;
  store: SessionStore;
  fetcher?: typeof fetch;
}

function invalid(message: string): NextResponse {
  return NextResponse.json({ message }, { status: 400 });
}

async function forward(
  path: '/modules' | '/modules/selection',
  method: 'GET' | 'PUT',
  dependencies: ModuleSelectionBffDependencies,
  featureKeys?: string[],
): Promise<NextResponse> {
  if (!dependencies.sessionId) {
    return NextResponse.json({ message: 'Authentication required' }, { status: 401 });
  }
  const token = await accessTokenForSession(
    dependencies.sessionId,
    dependencies.config,
    dependencies.store,
  );
  if (!token) {
    const response = NextResponse.json({ message: 'Authentication required' }, { status: 401 });
    clearSessionCookie(response);
    return response;
  }
  try {
    const upstream = await (dependencies.fetcher ?? fetch)(`${dependencies.config.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(featureKeys ? { 'content-type': 'application/json' } : {}),
      },
      body: featureKeys ? JSON.stringify({ featureKeys }) : undefined,
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
    return NextResponse.json({ message: 'Module selection is temporarily unavailable' }, { status: 502 });
  }
}

export function getModulesWith(dependencies: ModuleSelectionBffDependencies): Promise<NextResponse> {
  return forward('/modules', 'GET', dependencies);
}

export function putModuleSelectionWith(
  request: Request,
  featureKeys: string[],
  dependencies: ModuleSelectionBffDependencies,
): Promise<NextResponse> {
  if (!hasSameOrigin(request, dependencies.config.redirectUri)) {
    return Promise.resolve(NextResponse.json({ message: 'Forbidden origin' }, { status: 403 }));
  }
  if (
    featureKeys.length > MAX_FEATURE_KEYS ||
    featureKeys.some((key) => typeof key !== 'string' || !FEATURE_KEY.test(key))
  ) {
    return Promise.resolve(invalid('Invalid feature keys'));
  }
  return forward('/modules/selection', 'PUT', dependencies, [...new Set(featureKeys)].sort());
}

async function dependencies(): Promise<ModuleSelectionBffDependencies> {
  const config = getAuthConfig();
  return {
    config,
    sessionId: (await cookies()).get(SESSION_COOKIE)?.value,
    store: new RedisSessionStore(config.redisUrl),
  };
}

export async function getModules(): Promise<NextResponse> {
  return getModulesWith(await dependencies());
}

export async function putModuleSelection(request: Request): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return invalid('Malformed JSON body');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return invalid('Malformed module selection payload');
  }
  const featureKeys = (payload as { featureKeys?: unknown }).featureKeys;
  if (!Array.isArray(featureKeys)) return invalid('Malformed module selection payload');
  return putModuleSelectionWith(request, featureKeys as string[], await dependencies());
}
