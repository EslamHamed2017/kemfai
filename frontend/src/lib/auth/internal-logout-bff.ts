import { NextResponse } from 'next/server';
import { REFRESH_LOCK_TTL_MS } from './authenticated-session';
import type { AuthConfig } from './config';
import { clearInternalSessionCookie } from './internal-auth';
import { defaultProviderLogout } from './logout-bff';
import { hasSameOrigin } from './origin';
import type { SessionStore } from './session-store';

export interface InternalLogoutDependencies {
  config: AuthConfig;
  sessionId?: string;
  store: SessionStore;
  providerLogout?: (refreshToken: string, config: AuthConfig) => Promise<boolean>;
}

const response = (outcome: 'confirmed' | 'unconfirmed') => {
  const result = NextResponse.json({ outcome }, { status: outcome === 'confirmed' ? 200 : 502 });
  result.headers.set('cache-control', 'no-store');
  clearInternalSessionCookie(result);
  return result;
};

export async function postInternalLogoutWith(
  request: Request,
  dependencies: InternalLogoutDependencies,
): Promise<NextResponse> {
  if (!hasSameOrigin(request, dependencies.config.redirectUri)) {
    const denied = NextResponse.json({ code: 'FORBIDDEN_ORIGIN' }, { status: 403 });
    denied.headers.set('cache-control', 'no-store');
    return denied;
  }
  if (!dependencies.sessionId) return response('confirmed');

  const { sessionId, store, config } = dependencies;
  const owner = crypto.randomUUID();
  const locked = await store
    .tryAcquireRefreshLock(sessionId, owner, REFRESH_LOCK_TTL_MS)
    .catch(() => false);
  if (!locked) return response('unconfirmed');

  try {
    const current = await store.get(sessionId).catch(() => null);
    if (!current) return response('unconfirmed');
    const providerConfirmed = await (dependencies.providerLogout ?? defaultProviderLogout)(
      current.refreshToken,
      config,
    ).catch(() => false);
    const destroyed = await store
      .destroyIfCurrent(sessionId, current.refreshToken)
      .catch(() => false);
    return response(providerConfirmed && destroyed ? 'confirmed' : 'unconfirmed');
  } finally {
    await store.releaseRefreshLock(sessionId, owner).catch(() => undefined);
  }
}
