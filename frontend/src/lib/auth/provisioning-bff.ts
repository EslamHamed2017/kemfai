import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { accessTokenForSession } from './authenticated-session';
import { getAuthConfig, type AuthConfig } from './config';
import { clearSessionCookie, SESSION_COOKIE } from './cookies';
import { hasSameOrigin } from './origin';
import { parseRetryStatus } from './provisioning-status';
import { RedisSessionStore, type SessionStore } from './session-store';

export interface ProvisioningDependencies {
  config: AuthConfig;
  sessionId?: string;
  store: SessionStore;
  fetcher?: typeof fetch;
}

async function forward(
  method: 'GET' | 'POST',
  dependencies: ProvisioningDependencies,
): Promise<NextResponse> {
  const { config, sessionId, store } = dependencies;
  if (!sessionId) return NextResponse.json({ message: 'Authentication required' }, { status: 401 });
  const token = await accessTokenForSession(sessionId, config, store);
  if (!token) {
    const response = NextResponse.json({ message: 'Authentication required' }, { status: 401 });
    clearSessionCookie(response);
    return response;
  }
  try {
    const path = method === 'GET' ? '/tenants/me' : '/tenants/me/provisioning-retry';
    const upstream = await (dependencies.fetcher ?? fetch)(`${config.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    // Never forward arbitrary upstream bodies: diagnostics can contain secrets or tenant internals.
    if (upstream.status === 401) {
      const response = NextResponse.json({ message: 'Authentication required' }, { status: 401 });
      clearSessionCookie(response);
      return response;
    }
    if (
      upstream.status === 403 ||
      upstream.status === 404 ||
      upstream.status === 409 ||
      upstream.status === 503
    ) {
      return NextResponse.json(
        { message: 'Provisioning unavailable' },
        { status: upstream.status },
      );
    }
    if (!upstream.ok)
      return NextResponse.json({ message: 'Provisioning unavailable' }, { status: 502 });
    const body: unknown = await upstream.json();
    if (method === 'POST') {
      // A retry only ever documents Pending (ordinary retry) or Ready (the narrow
      // Odoo-company repair) for its 202 — a tighter, shared validator than GET's
      // full TenantStatus enum below. Anything outside that is a malformed/unsafe
      // upstream body and must fail the same way a network error does
      // (service-error semantics), never reach the screen as a status it might
      // render or apply.
      const safe = parseRetryStatus(body);
      if (!safe) throw new Error('Invalid tenant status');
      return NextResponse.json(safe, { status: 202, headers: { 'cache-control': 'no-store' } });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error('Invalid tenant status');
    // tenantId is a plain opaque identifier (part of the documented TenantStatus
    // schema) and safe to forward; failureReason can carry raw upstream diagnostic
    // text and stays stripped, same as every other error body on this route.
    const { status, tenantId } = body as { status?: unknown; tenantId?: unknown };
    if (!['Pending', 'Creating', 'Ready', 'Failed'].includes(String(status))) {
      return NextResponse.json({ status: 'Unknown' }, { headers: { 'cache-control': 'no-store' } });
    }
    return NextResponse.json(
      { status, tenantId: typeof tenantId === 'string' ? tenantId : null },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ message: 'Provisioning unavailable' }, { status: 502 });
  }
}

export const getProvisioningWith = (dependencies: ProvisioningDependencies) =>
  forward('GET', dependencies);
export function retryProvisioningWith(request: Request, dependencies: ProvisioningDependencies) {
  if (!hasSameOrigin(request, dependencies.config.redirectUri)) {
    return Promise.resolve(NextResponse.json({ message: 'Forbidden origin' }, { status: 403 }));
  }
  return forward('POST', dependencies);
}

async function dependencies(): Promise<ProvisioningDependencies> {
  const config = getAuthConfig();
  return {
    config,
    sessionId: (await cookies()).get(SESSION_COOKIE)?.value,
    store: new RedisSessionStore(config.redisUrl),
  };
}
export async function getProvisioning() {
  return getProvisioningWith(await dependencies());
}
export async function retryProvisioning(request: Request) {
  return retryProvisioningWith(request, await dependencies());
}
