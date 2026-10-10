import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import type { components } from '@/lib/api-client';
import { accessTokenForSession } from './authenticated-session';
import { getAuthConfig, type AuthConfig } from './config';
import { clearSessionCookie, SESSION_COOKIE } from './cookies';
import { hasSameOrigin } from './origin';
import { RedisSessionStore, type SessionStore } from './session-store';

type CompanySettingsInput = components['schemas']['CompanySettingsInput'];

export interface CompanySettingsBffDependencies {
  config: AuthConfig;
  sessionId?: string;
  store: SessionStore;
  fetcher?: typeof fetch;
}

async function forward(
  method: 'GET' | 'PUT',
  body: CompanySettingsInput | undefined,
  dependencies: CompanySettingsBffDependencies,
  idempotencyKey?: string,
): Promise<NextResponse> {
  const { config, sessionId, store } = dependencies;
  const fetcher = dependencies.fetcher ?? fetch;
  if (!sessionId) return NextResponse.json({ message: 'Authentication required' }, { status: 401 });

  const token = await accessTokenForSession(sessionId, config, store);
  if (!token) {
    const response = NextResponse.json({ message: 'Authentication required' }, { status: 401 });
    clearSessionCookie(response);
    return response;
  }

  try {
    const upstream = await fetcher(`${config.apiUrl}/companies/current/settings`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (upstream.status === 401) {
      const response = NextResponse.json({ message: 'Authentication required' }, { status: 401 });
      clearSessionCookie(response);
      return response;
    }
    const text = await upstream.text();
    return new NextResponse(text || null, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json(
      { message: 'Company settings are temporarily unavailable' },
      { status: 502 },
    );
  }
}

export function getCompanySettingsWith(
  dependencies: CompanySettingsBffDependencies,
): Promise<NextResponse> {
  return forward('GET', undefined, dependencies);
}

export function putCompanySettingsWith(
  request: Request,
  body: CompanySettingsInput,
  dependencies: CompanySettingsBffDependencies,
): Promise<NextResponse> {
  if (!hasSameOrigin(request, dependencies.config.redirectUri)) {
    return Promise.resolve(NextResponse.json({ message: 'Forbidden origin' }, { status: 403 }));
  }
  const idempotencyKey = request.headers.get('idempotency-key')?.trim() || undefined;
  return forward('PUT', body, dependencies, idempotencyKey);
}

async function dependencies(): Promise<CompanySettingsBffDependencies> {
  const config = getAuthConfig();
  return {
    config,
    sessionId: (await cookies()).get(SESSION_COOKIE)?.value,
    store: new RedisSessionStore(config.redisUrl),
  };
}

export async function getCompanySettings(): Promise<NextResponse> {
  return getCompanySettingsWith(await dependencies());
}

export async function putCompanySettings(request: Request): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ message: 'Malformed JSON body' }, { status: 400 });
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    typeof (payload as { values?: unknown }).values !== 'object' ||
    (payload as { values?: unknown }).values === null ||
    Array.isArray((payload as { values?: unknown }).values)
  ) {
    return NextResponse.json({ message: 'Malformed settings payload' }, { status: 400 });
  }
  return putCompanySettingsWith(request, payload as CompanySettingsInput, await dependencies());
}
