'use server';

import { cookies, headers } from 'next/headers';

import { SESSION_COOKIE } from '../auth/cookies';
import { defaultLocale, isLocale, localeCookieName, type Locale } from './config';

/**
 * T104/FR-024 — locale resolution order:
 *   1. Authenticated session: the persisted `Account.preferred_locale` (follows the
 *      account across sessions — T103's criterion).
 *   2. `KEMFAI_LOCALE` cookie — the LocaleSwitcher's immediate re-render path.
 *   3. `?locale=` URL parameter — URL-driven selection (shareable locale links).
 *   4. `Accept-Language` header — pre-auth browser detection for anonymous visitors
 *      (an Arabic-browser session renders Arabic on public pages, per T104's criterion).
 *   5. `defaultLocale` (en).
 * 'use server' keeps cookie writes server-only, unchanged from T023.
 */
export async function getUserLocale(): Promise<Locale> {
  const persisted = await getAuthenticatedLocale();
  if (persisted) return persisted;

  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(localeCookieName)?.value;
  if (isLocale(cookieValue)) return cookieValue;

  const urlLocale = new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3411').searchParams.get('locale');
  if (isLocale(urlLocale)) return urlLocale;

  return getBrowserLocale(await headers());
}

export async function setUserLocale(locale: Locale): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(localeCookieName, locale, {
    path: '/',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  });
}

/**
 * Pre-auth browser detection (T104): parses the request's Accept-Language per RFC 9110
 * with q-values, matching any listed tag whose primary subtag is `ar` or `en` in order
 * of preference. Absent/unmatched headers fall back to the default locale.
 */
function getBrowserLocale(headerBag: Headers): Locale {
  const header = headerBag.get('accept-language');
  if (!header) return defaultLocale;
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = Number(params.find((p) => p.trim().startsWith('q='))?.split('=')[1] ?? '1');
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    if (tag.startsWith('ar')) return 'ar';
    if (tag.startsWith('en')) return 'en';
  }
  return defaultLocale;
}

/**
 * Session-persisted preference (T104) — DIRECT server-side call to the control-plane
 * (never a self-fetch to our own Next server: that deadlocks prerendering). Gated on
 * an existing session cookie so anonymous traffic and static generation perform ZERO
 * network I/O, and hard-bounded by an abort timeout so rendering can never hang.
 * `undefined` for anonymous visitors, no stored preference yet, or transient failures.
 */
async function getAuthenticatedLocale(): Promise<Locale | undefined> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return undefined; // build/prerender/anonymous: no network at all
  try {
    const { accessTokenForSession } = await import('../auth/authenticated-session');
    const { getAuthConfig } = await import('../auth/config');
    const { RedisSessionStore } = await import('../auth/session-store');
    const config = getAuthConfig();
    const token = await accessTokenForSession(sessionId, config, new RedisSessionStore(config.redisUrl));
    if (!token) return undefined;
    const response = await fetch(`${config.apiUrl}/accounts/me/locale`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { locale?: string | null };
    return isLocale(data.locale) ? data.locale : undefined;
  } catch {
    return undefined;
  }
}
