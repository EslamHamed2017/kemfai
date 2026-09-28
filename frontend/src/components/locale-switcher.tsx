'use client';

import { useTransition } from 'react';
import { useLocale } from 'next-intl';

import type { Locale } from '@/lib/i18n/config';

/**
 * T104 — the production locale switcher (FR-024). A real user click does BOTH:
 * 1. `setUserLocale(next)` — the cookie that drives next-intl's request-time locale
 *    resolution (`i18n/request.ts` → `getUserLocale()`) for the immediate re-render; and
 * 2. `PATCH /api/accounts/me/locale` — persisting the choice to `Account.preferred_locale`
 *    so it survives logout/fresh login (T103's cross-session criterion). Anonymous
 *    visitors get 401 from the BFF and simply keep the cookie-only behavior — public
 *    pages remain browser/URL-driven per T104's pre-auth acceptance criteria.
 * The button sits inside the <header> landmark (axe `region` rule, T030 suite).
 */
export function LocaleSwitcher() {
  const active = useLocale();
  const [pending, startTransition] = useTransition();

  const next: Locale = active === 'ar' ? 'en' : 'ar';

  async function switchTo(target: Locale): Promise<void> {
    const { setUserLocale } = await import('@/lib/i18n/locale');
    await setUserLocale(target);
    try {
      const response = await fetch('/api/accounts/me/locale', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: target }),
      });
      // 401 = anonymous visitor: cookie-only persistence is the documented fallback.
      if (!response.ok && response.status !== 401) {
        console.warn(`locale persistence skipped (HTTP ${response.status})`);
      }
    } catch {
      console.warn('locale persistence skipped (network error)');
    }
    startTransition(() => {
      window.location.reload();
    });
  }

  const label = active === 'ar' ? 'English' : 'العربية';

  return (
    <button
      type="button"
      data-testid="locale-switcher"
      data-next-locale={next}
      lang={active === 'ar' ? 'en' : 'ar'}
      disabled={pending}
      onClick={() => void switchTo(next)}
    >
      {label}
    </button>
  );
}
