import ar from '../../src/locales/ar/common.json';
import en from '../../src/locales/en/common.json';

function collectKeyPaths(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, nested]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    return nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? collectKeyPaths(nested as Record<string, unknown>, path)
      : [path];
  });
}

describe('i18n message catalogs', () => {
  it('keeps EN and AR catalogs in lockstep so no locale silently falls back', () => {
    expect(collectKeyPaths(ar).sort()).toEqual(collectKeyPaths(en).sort());
  });

  it('never leaves a message value empty in either locale', () => {
    for (const catalog of [en, ar]) {
      for (const path of collectKeyPaths(catalog)) {
        const value = path.split('.').reduce<unknown>((acc, key) => {
          return (acc as Record<string, unknown>)[key];
        }, catalog);

        expect(typeof value).toBe('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });
});
