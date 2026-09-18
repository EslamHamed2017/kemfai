import { defaultLocale, getDirection, isLocale, locales } from '../../src/lib/i18n/config';

describe('i18n config', () => {
  it('exposes exactly the EN and AR locales', () => {
    expect(locales).toEqual(['en', 'ar']);
  });

  it('defaults to English', () => {
    expect(defaultLocale).toBe('en');
  });

  it('marks Arabic as right-to-left', () => {
    expect(getDirection('ar')).toBe('rtl');
  });

  it('marks English as left-to-right', () => {
    expect(getDirection('en')).toBe('ltr');
  });

  it('recognizes only supported locale strings', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(null)).toBe(false);
  });
});
