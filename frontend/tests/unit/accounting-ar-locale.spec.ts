import ar from '../../src/locales/ar/common.json';
import en from '../../src/locales/en/common.json';

type Catalog = Record<string, unknown>;

function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Catalog).reduce<Record<string, string>>(
    (messages, [key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof child === 'string') messages[path] = child;
      else Object.assign(messages, flatten(child, path));
      return messages;
    },
    {},
  );
}

const storyOneSections = ['accountingCoa', 'accountingDraft'] as const;
const storyTwoSections = ['accountingDimensions'] as const;
const english = flatten(en);
const arabic = flatten(ar);
const storyOneKeys = Object.keys(english)
  .filter((key) => storyOneSections.some((section) => key.startsWith(`${section}.`)))
  .sort();

describe('Story 1 Arabic accounting catalog (T066)', () => {
  it('has exact key parity with English for COA and draft messages', () => {
    const arabicKeys = Object.keys(arabic)
      .filter((key) => storyOneSections.some((section) => key.startsWith(`${section}.`)))
      .sort();
    expect(arabicKeys).toEqual(storyOneKeys);
  });

  it.each(storyOneKeys)('%s resolves to Arabic instead of English or a raw/fallback key', (key) => {
    const value = arabic[key];
    expect(value).toEqual(expect.any(String));
    expect(value.trim()).not.toBe('');
    expect(value).not.toBe(english[key]);
    expect(value).not.toBe(key);
    expect(value).not.toBe(key.split('.').at(-1));
    expect(value).toMatch(/[\u0600-\u06ff]/);
  });

  it('keeps the draft explicitly non-posting and preserves safe error meaning', () => {
    expect(arabic['accountingDraft.nonPostingNotice']).toMatch(/لا يمكن ترحيلها|لا تُرحّل/);
    expect(arabic['accountingDraft.nonPostingNotice']).toMatch(/ولا تُنشئ قيودًا في دفتر الأستاذ/);
    expect(arabic['accountingDraft.saved']).toMatch(/دون أثر.*دفتر الأستاذ/);
    expect(arabic['accountingDraft.errors.accountNotPosting']).toMatch(/حساب ترحيل نشط/);
    expect(arabic['accountingDraft.errors.accountNotPosting']).toMatch(/الرئيسية.*غير النشطة/);
    expect(arabic['accountingDraft.errors.mutation']).toMatch(/مدخلاتك محفوظة/);
  });
});

describe('Story 2 Arabic accounting catalog (T101)', () => {
  const storyTwoKeys = Object.keys(english)
    .filter(
      (key) =>
        storyTwoSections.some((section) => key.startsWith(`${section}.`)) ||
        key.startsWith('accountingDraft.dimensions.') ||
        key.startsWith('accountingDraft.errors.DIMENSION_'),
    )
    .sort();

  it('has exact key parity with English for dimensions, rules, and draft-validation messages', () => {
    const arabicKeys = Object.keys(arabic)
      .filter(
        (key) =>
          storyTwoSections.some((section) => key.startsWith(`${section}.`)) ||
          key.startsWith('accountingDraft.dimensions.') ||
          key.startsWith('accountingDraft.errors.DIMENSION_'),
      )
      .sort();
    expect(arabicKeys).toEqual(storyTwoKeys);
  });

  it.each(storyTwoKeys)('%s resolves to Arabic instead of English or a raw/fallback key', (key) => {
    const value = arabic[key];
    expect(value).toEqual(expect.any(String));
    expect(value.trim()).not.toBe('');
    expect(value).not.toBe(english[key]);
    expect(value).not.toBe(key);
    expect(value).not.toBe(key.split('.').at(-1));
    expect(value).toMatch(/[\u0600-\u06ff]/);
  });

  it('preserves required, prohibited, inactive, and company-scope validation meaning', () => {
    expect(arabic['accountingDraft.errors.DIMENSION_REQUIRED']).toMatch(/مطلوب/);
    expect(arabic['accountingDraft.errors.DIMENSION_PROHIBITED']).toMatch(/غير مسموح|محظور/);
    expect(arabic['accountingDraft.errors.DIMENSION_VALUE_INACTIVE']).toMatch(/غير نشطة/);
    expect(arabic['accountingDraft.errors.DIMENSION_VALUE_SCOPE']).toMatch(
      /الشركة.*البُعد|البُعد.*الشركة/,
    );
  });
});

describe('Story 3 Arabic accounting catalog (T137)', () => {
  const storyThreeKeys = Object.keys(english)
    .filter(
      (key) =>
        key.startsWith('accounting.') ||
        key.startsWith('accountingDraft.journals.') ||
        key.startsWith('accountingDraft.currencies.') ||
        key.startsWith('accountingDraft.preview.') ||
        [
          'accountingDraft.fields.rateReference',
          'accountingDraft.fields.rateEffectiveDate',
          'accountingDraft.errors.rateReferenceEffectiveRequired',
          'accountingDraft.errors.configurationStale',
        ].includes(key),
    )
    .sort();

  it('has exact key parity with English for journal, currency, full-draft, and preview messages', () => {
    const arabicKeys = Object.keys(arabic)
      .filter(
        (key) =>
          key.startsWith('accounting.') ||
          key.startsWith('accountingDraft.journals.') ||
          key.startsWith('accountingDraft.currencies.') ||
          key.startsWith('accountingDraft.preview.') ||
          [
            'accountingDraft.fields.rateReference',
            'accountingDraft.fields.rateEffectiveDate',
            'accountingDraft.errors.rateReferenceEffectiveRequired',
            'accountingDraft.errors.configurationStale',
          ].includes(key),
      )
      .sort();
    expect(arabicKeys).toEqual(storyThreeKeys);
  });

  it.each(storyThreeKeys)(
    '%s resolves to Arabic instead of English or a raw/fallback key',
    (key) => {
      const value = arabic[key];
      expect(value).toEqual(expect.any(String));
      expect(value.trim()).not.toBe('');
      expect(value).not.toBe(english[key]);
      expect(value).not.toBe(key);
      expect(value).not.toBe(key.split('.').at(-1));
      expect(value).toMatch(/[\u0600-\u06ff]/);
    },
  );

  it('states that draft validation has no ledger effect and is not posting', () => {
    expect(arabic['accountingDraft.preview.nonPosting']).toMatch(/دون أثر.*دفتر الأستاذ/);
    expect(arabic['accountingDraft.preview.nonPosting']).toMatch(/ليس ترحيلاً|لا يُرحّل/);
  });
});
