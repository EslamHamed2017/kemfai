export const locales = ['en', 'ar'] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

export const localeCookieName = 'KEMFAI_LOCALE';

type Direction = 'ltr' | 'rtl';

const rtlLocales: ReadonlySet<Locale> = new Set(['ar']);

export function isLocale(value: string | undefined | null): value is Locale {
  return locales.includes(value as Locale);
}

export function getDirection(locale: Locale): Direction {
  return rtlLocales.has(locale) ? 'rtl' : 'ltr';
}
