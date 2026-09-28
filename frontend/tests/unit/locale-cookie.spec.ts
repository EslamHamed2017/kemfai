const cookieStore = new Map<string, string>();

jest.mock('next/headers', () => ({
  headers: async () => new Headers({ 'accept-language': 'en-US,en;q=0.9' }),
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieStore.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      cookieStore.set(name, value);
    },
  }),
}));

import { getUserLocale, setUserLocale } from '../../src/lib/i18n/locale';

describe('locale cookie persistence', () => {
  beforeEach(() => {
    cookieStore.clear();
  });

  it('falls back to English when no locale cookie is set', async () => {
    expect(await getUserLocale()).toBe('en');
  });

  it('reads back a persisted Arabic locale', async () => {
    await setUserLocale('ar');

    expect(await getUserLocale()).toBe('ar');
  });

  it('falls back to English for an unrecognized cookie value', async () => {
    cookieStore.set('KEMFAI_LOCALE', 'fr');

    expect(await getUserLocale()).toBe('en');
  });
});
