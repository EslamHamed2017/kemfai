import { defaultLocale, isLocale, localeCookieName, type Locale } from '../i18n/config';
import ar from '../../locales/ar/common.json';
import en from '../../locales/en/common.json';

const messagesByLocale: Record<Locale, typeof en> = { en, ar };

/**
 * T037 — shared by the `/login` and `/reset-password` route handlers (Acceptance Scenario
 * 1.6's duplicate-email recovery actions). Reads the locale cookie directly off the Request
 * rather than via `next/headers` so this stays a plain, independently testable function.
 */
export function localeFromRequest(request: Request): Locale {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const raw = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${localeCookieName}=`))
    ?.slice(localeCookieName.length + 1);

  return isLocale(raw) ? raw : defaultLocale;
}

/**
 * Redirects to `targetUrl` (a deployment-configured Keycloak customer-realm URL — never a
 * hard-coded host or realm name; see infra/.env.example) when it is configured. When it is
 * absent, a redirect would land on a dead link, so this renders a minimal localized
 * "temporarily unavailable" page instead — the recovery action must never dead-end.
 */
export function recoveryRedirectResponse(targetUrl: string | undefined, locale: Locale): Response {
  if (targetUrl) {
    return Response.redirect(targetUrl, 302);
  }

  const message = messagesByLocale[locale].signup.duplicateEmail.recoveryUnavailable;
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const escaped = escapeHtml(message);
  const html = `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8" /><title>${escaped}</title></head><body><main role="alert"><p>${escaped}</p></main></body></html>`;

  return new Response(html, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
