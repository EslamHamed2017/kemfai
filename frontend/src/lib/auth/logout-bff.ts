import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { REFRESH_LOCK_TTL_MS } from './authenticated-session';
import { getAuthConfig, type AuthConfig } from './config';
import { clearSessionCookie, SESSION_COOKIE } from './cookies';
import { hasSameOrigin } from './origin';
import { RedisSessionStore, type SessionStore } from './session-store';

const PROVIDER_LOGOUT_TIMEOUT_MS = 8000;

export type LogoutOutcome = 'confirmed' | 'unconfirmed';

export interface LogoutBffDependencies {
  config: AuthConfig;
  sessionId?: string;
  store: SessionStore;
  /** Injectable seam for tests; production default POSTs to Keycloak's realm logout endpoint. */
  providerLogout?: (refreshToken: string, config: AuthConfig) => Promise<boolean>;
}

/**
 * Keycloak 26 proof (owned scratch realm, T056 point 2): a server-side POST to
 * `${issuer}/protocol/openid-connect/logout` with `client_id` + the server-held refresh
 * token terminates the user's SSO session — verified both for a confidential client (with
 * client_secret) and for OUR actual public-client configuration (no secret, PKCE only):
 * the browser's KEYCLOAK_IDENTITY/KEYCLOAK_SESSION cookies are rejected on the very next
 * authorization request, which Keycloak answers with the hosted login form instead of a
 * silent redirect. Keycloak returns exactly 204 for both a live session AND a session
 * already terminated by a prior call with the same refresh token (idempotent) — any other
 * status (400 invalid_grant for a garbage/expired token, a transport error, a timeout) is
 * treated as provider-unconfirmed, never guessed as success.
 */
export async function defaultProviderLogout(
  refreshToken: string,
  config: AuthConfig,
): Promise<boolean> {
  const response = await fetch(`${config.backchannelUrl}/protocol/openid-connect/logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, refresh_token: refreshToken }),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(PROVIDER_LOGOUT_TIMEOUT_MS),
  });
  return response.status === 204;
}

function noStoreJson(body: Record<string, unknown>, status: number): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('cache-control', 'no-store');
  return response;
}

/**
 * T056 point 2 (corrective) — same-origin logout that genuinely terminates the Keycloak
 * SSO session instead of only destroying the local Redis-backed record.
 *
 * Invariant preserved from the prior local-only design: after a valid same-origin
 * request, local session destruction and cookie expiry are ALWAYS attempted, even if
 * provider communication, session loading, lock acquisition, or Redis deletion fails.
 * What changes is that a provider failure is never reported as a successful account
 * switch — the response body only ever says whether the provider confirmed termination,
 * never `loggedOut: true` unconditionally, and never anything resembling a token,
 * endpoint, or provider response body.
 */
export async function postLogoutWith(
  request: Request,
  dependencies: LogoutBffDependencies,
): Promise<NextResponse> {
  if (!hasSameOrigin(request, dependencies.config.redirectUri)) {
    return noStoreJson({ message: 'Forbidden origin' }, 403);
  }

  const { sessionId, store, config } = dependencies;
  const providerLogout = dependencies.providerLogout ?? defaultProviderLogout;
  // No app session cookie at all: there is no refresh token to hand the provider, and
  // nothing local to destroy — the caller's goal ("this browser holds no session") is
  // already satisfied. This is the one path that is success without a provider round
  // trip; every path below that HAD a session but could not confirm provider
  // termination is reported as unconfirmed, never as success.
  let outcome: LogoutOutcome = sessionId ? 'unconfirmed' : 'confirmed';

  if (sessionId) {
    const owner = crypto.randomUUID();
    const locked = await store
      .tryAcquireRefreshLock(sessionId, owner, REFRESH_LOCK_TTL_MS)
      .catch(() => false);
    try {
      if (locked) {
        const current = await store.get(sessionId).catch(() => null);
        if (current) {
          const confirmed = await providerLogout(current.refreshToken, config).catch(() => false);
          if (confirmed) {
            outcome = 'confirmed';
            await store.destroyIfCurrent(sessionId, current.refreshToken).catch(() => undefined);
          } else {
            await store.destroy(sessionId).catch(() => undefined);
          }
        } else {
          // Session already gone/unreadable: nothing to destroy, provider was never told.
          await store.destroy(sessionId).catch(() => undefined);
        }
      } else {
        // Lock contention: another request owns the refresh token right now. Still clean
        // up the local record best-effort, but never claim the provider was reached.
        await store.destroy(sessionId).catch(() => undefined);
      }
    } finally {
      if (locked) await store.releaseRefreshLock(sessionId, owner).catch(() => undefined);
    }
  }

  const response = noStoreJson({ outcome }, outcome === 'confirmed' ? 200 : 502);
  clearSessionCookie(response);
  return response;
}

/** Route wrapper: resolves the session cookie into explicit dependencies. */
export async function postLogout(request: Request): Promise<NextResponse> {
  const config = getAuthConfig();
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value;
  return postLogoutWith(request, {
    config,
    sessionId,
    store: new RedisSessionStore(config.redisUrl),
  });
}
