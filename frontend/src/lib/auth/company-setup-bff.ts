import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { accessTokenForSession } from './authenticated-session';
import { getAuthConfig, type AuthConfig } from './config';
import { clearSessionCookie, SESSION_COOKIE } from './cookies';
import { hasSameOrigin } from './origin';
import { RedisSessionStore, type SessionStore } from './session-store';

export interface CompanySetupBffDependencies {
  config: AuthConfig;
  sessionId?: string;
  store: SessionStore;
  fetcher?: typeof fetch;
}

/**
 * T056 — BFF core for `GET`/`PUT /companies/current/setup` and
 * `POST /companies/current/setup/complete` (T054/T055). Every response body below
 * originates entirely from this codebase's own NestJS guards/services
 * (company-setup.service.ts's `callOrTranslate` already replaces any unrecognized
 * Odoo/RPC error with a generic message before it ever reaches here) — never raw
 * Odoo/Postgres detail — so, unlike provisioning-bff's reshaping, the upstream
 * status/body is passed through unchanged for the wizard screen to classify and
 * localize. Only 401 is reshaped, to also clear the stale session cookie.
 */
async function forward(
  path: '/companies/current/setup' | '/companies/current/setup/complete',
  method: 'GET' | 'PUT' | 'POST',
  body: unknown,
  dependencies: CompanySetupBffDependencies,
  scope?: string | null,
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
    const upstream = await fetcher(`${config.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        // T056 binding-review point 1 — forwarded unchanged so the API can recompute and
        // check the scope precondition BEFORE any Odoo mutation; the BFF never
        // interprets or strips it.
        ...(scope ? { 'x-kemfai-setup-scope': scope } : {}),
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
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ message: 'Company setup is temporarily unavailable' }, { status: 502 });
  }
}

export function getCompanySetupWith(dependencies: CompanySetupBffDependencies): Promise<NextResponse> {
  return forward('/companies/current/setup', 'GET', undefined, dependencies);
}

/**
 * T056 round 3 — `X-KEMFAI-Setup-Scope` is REQUIRED on every mutation; the BFF itself
 * rejects a missing/blank header with 412 before ever reaching the upstream `fetch`,
 * rather than relying solely on the API to reject it. No "first save" exception: every
 * mutation is preceded by a GET that returns a scope, so there is always one to echo.
 */
function requireScopeHeader(request: Request): string | NextResponse {
  const scope = request.headers.get('x-kemfai-setup-scope');
  if (!scope?.trim()) {
    return NextResponse.json({ message: 'X-KEMFAI-Setup-Scope header is required' }, { status: 412 });
  }
  return scope;
}

export function putCompanySetupWith(
  request: Request,
  body: { step: string; values: Record<string, unknown>; baseVersion?: number | null },
  dependencies: CompanySetupBffDependencies,
): Promise<NextResponse> {
  if (!hasSameOrigin(request, dependencies.config.redirectUri)) {
    return Promise.resolve(NextResponse.json({ message: 'Forbidden origin' }, { status: 403 }));
  }
  const scope = requireScopeHeader(request);
  if (typeof scope !== 'string') return Promise.resolve(scope);
  return forward('/companies/current/setup', 'PUT', body, dependencies, scope);
}

export function completeCompanySetupWith(
  request: Request,
  dependencies: CompanySetupBffDependencies,
): Promise<NextResponse> {
  if (!hasSameOrigin(request, dependencies.config.redirectUri)) {
    return Promise.resolve(NextResponse.json({ message: 'Forbidden origin' }, { status: 403 }));
  }
  const scope = requireScopeHeader(request);
  if (typeof scope !== 'string') return Promise.resolve(scope);
  return forward('/companies/current/setup/complete', 'POST', undefined, dependencies, scope);
}

async function dependencies(): Promise<CompanySetupBffDependencies> {
  const config = getAuthConfig();
  return {
    config,
    sessionId: (await cookies()).get(SESSION_COOKIE)?.value,
    store: new RedisSessionStore(config.redisUrl),
  };
}

export async function getCompanySetup(): Promise<NextResponse> {
  return getCompanySetupWith(await dependencies());
}

export async function putCompanySetup(request: Request): Promise<NextResponse> {
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
    typeof (payload as { step?: unknown }).step !== 'string' ||
    typeof (payload as { values?: unknown }).values !== 'object' ||
    (payload as { values?: unknown }).values === null
  ) {
    return NextResponse.json({ message: 'Malformed step payload' }, { status: 400 });
  }
  const { step, values, baseVersion } = payload as {
    step: string;
    values: Record<string, unknown>;
    baseVersion?: number | null;
  };
  return putCompanySetupWith(request, { step, values, baseVersion }, await dependencies());
}

export async function completeCompanySetup(request: Request): Promise<NextResponse> {
  return completeCompanySetupWith(request, await dependencies());
}
