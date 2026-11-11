import type { ComponentType } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ar from '../../src/locales/ar/common.json';
import en from '../../src/locales/en/common.json';

let activeLocale: 'en' | 'ar' = 'en';
jest.mock('next-intl', () => ({
  useLocale: () => activeLocale,
  useTranslations: (namespace: string) => (key: string) => {
    const catalog = activeLocale === 'ar' ? ar : en;
    return `${namespace}.${key}`
      .split('.')
      .reduce<unknown>(
        (value, segment) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)[segment]
            : undefined,
        catalog,
      ) as string;
  },
}));

type DraftModule = { DraftComposer: ComponentType<{ companyId?: string }> };
function draftComposer() {
  const path = '../../src/app/(workspace)/accounting/drafts/' + 'draft-composer';
  return jest.requireActual<DraftModule>(path).DraftComposer;
}
function response(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  };
}
const account = {
  id: '91919191-1111-4111-8111-111111111111',
  code: '6100',
  name: { en: 'Professional fees', ar: 'أتعاب مهنية' },
  accountType: 'expense',
  nodeKind: 'posting',
  parentId: null,
  active: true,
  selectableForDraftLines: true,
  version: 6,
};
const journal = {
  id: '92929292-1111-4111-8111-111111111111',
  code: 'GEN',
  name: { en: 'General journal', ar: 'دفتر اليومية العام' },
  journalType: 'general',
  active: true,
  selectableForDrafts: true,
  version: 4,
};
const aed = {
  id: '93939393-1111-4111-8111-111111111111',
  currencyCode: 'AED',
  enabled: true,
  isBase: true,
  nativeDecimalPlaces: 2,
  nativeMetadataVersion: 'AED-native-v3',
  version: 5,
};
const usd = {
  id: '93939393-2222-4222-8222-222222222222',
  currencyCode: 'USD',
  enabled: true,
  isBase: false,
  nativeDecimalPlaces: 2,
  nativeMetadataVersion: 'USD-native-v8',
  version: 11,
};
const draftId = '94949494-1111-4111-8111-111111111111';
const page = (items: unknown[]) => ({ items, nextCursor: null });
function validationResponse() {
  return {
    result: {
      id: '95959595-1111-4111-8111-111111111111',
      draftId,
      draftVersion: 2,
      status: 'invalid',
      ledgerEffect: 'none',
      checksPerformed: ['exact_money_metadata', 'base_arithmetic'],
      errors: [
        {
          code: 'BASE_TOTALS_UNBALANCED',
          messageKey: 'draft.unbalanced',
          lineId: null,
          resourceId: null,
          field: 'lines',
        },
      ],
      warnings: [
        {
          code: 'JOURNAL_INACTIVE',
          messageKey: 'draft.journalInactive',
          lineId: null,
          resourceId: journal.id,
          field: 'journalId',
        },
      ],
      policyBlockers: [
        {
          code: 'AMOUNT_SCALE_EXCEEDS_METADATA',
          messageKey: 'draft.scale',
          lineId: account.id,
          resourceId: usd.id,
          field: 'transactionDebit',
        },
      ],
      companyBaseCurrencyCode: 'AED',
      basePrecision: 2,
      baseDebitTotal: '100.00009',
      baseCreditTotal: '99.99000',
      configurationSnapshot: {
        accounts: { [account.id]: account.version },
        dimensionRules: {},
        journal: { id: journal.id, version: journal.version },
        currencies: {
          AED: {
            currencyCode: 'AED',
            configurationVersion: aed.version,
            nativeMetadataVersion: aed.nativeMetadataVersion,
            nativeDecimalPlaces: 2,
          },
          USD: {
            currencyCode: 'USD',
            configurationVersion: usd.version,
            nativeMetadataVersion: usd.nativeMetadataVersion,
            nativeDecimalPlaces: 2,
          },
        },
      },
      validatedAt: '2026-11-07T12:00:00.000Z',
    },
    ledgerEffect: 'none',
  };
}
function successfulFetch(url: string, init?: RequestInit) {
  if (url.endsWith('/validate'))
    return Promise.resolve(response(200, validationResponse(), { etag: '"2"' }));
  if (url === '/api/accounting/v1/drafts' && init?.method === 'POST')
    return Promise.resolve(
      response(
        201,
        {
          resource: { id: draftId, version: 1, status: 'draft', ledgerEffect: 'none' },
          ledgerEffect: 'none',
        },
        { etag: '"1"' },
      ),
    );
  if (url.includes('/journals')) return Promise.resolve(response(200, page([journal])));
  if (url.includes('/currencies')) return Promise.resolve(response(200, page([aed, usd])));
  if (url.includes('/accounts')) return Promise.resolve(response(200, page([account])));
  if (url.includes('/dimension-')) return Promise.resolve(response(200, page([])));
  return Promise.resolve(response(404, {}));
}
async function addLines(count: number) {
  const selector = await screen.findByTestId('draft-account');
  for (let index = 0; index < count; index += 1) {
    fireEvent.change(selector, { target: { value: account.id } });
    fireEvent.click(screen.getByTestId('draft-line-add'));
  }
}
function setInput(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}
beforeEach(() => {
  activeLocale = 'en';
  jest.restoreAllMocks();
});

describe('Accounting full draft composer (T113)', () => {
  it('submits five independent lines with exact lexemes, master versions, and FX provenance', async () => {
    const fetchMock = jest.fn(successfulFetch);
    global.fetch = fetchMock as unknown as typeof fetch;
    const Draft = draftComposer();
    render(<Draft companyId="company-a1" />);
    await addLines(5);
    fireEvent.change(screen.getByTestId('draft-journal'), { target: { value: journal.id } });
    setInput('draft-accounting-date', '2026-11-07');
    const amounts = ['10.00001', '20.20000', '30.00300', '39.79699', '0.00000'];
    amounts.forEach((amount, index) => {
      fireEvent.change(screen.getByTestId(`draft-line-${index}-transaction-currency`), {
        target: { value: index ? 'AED' : 'USD' },
      });
      setInput(`draft-line-${index}-transaction-debit`, amount);
      setInput(`draft-line-${index}-transaction-credit`, '0.00000');
      setInput(`draft-line-${index}-base-debit`, amount);
      setInput(`draft-line-${index}-base-credit`, '0.00000');
    });
    setInput('draft-line-0-rate-reference', 'treasury-manual-2026-11-07');
    setInput('draft-line-0-rate-effective-date', '2026-11-07');
    fireEvent.click(screen.getByTestId('draft-save'));
    await screen.findByTestId('draft-saved');
    const save = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/accounting/v1/drafts' && init?.method === 'POST',
    );
    const body = JSON.parse(String(save?.[1]?.body));
    expect(body.journalId).toBe(journal.id);
    expect(body.lines.map((line: { transactionDebit: string }) => line.transactionDebit)).toEqual(
      amounts,
    );
    expect(body.lines[0]).toEqual(
      expect.objectContaining({
        transactionCurrencyCode: 'USD',
        transactionPrecision: 2,
        transactionCurrencyMetadataVersion: usd.nativeMetadataVersion,
        companyBaseCurrencyCode: 'AED',
        basePrecision: 2,
        baseCurrencyMetadataVersion: aed.nativeMetadataVersion,
        currencyConfigurationVersion: usd.version,
        rateReference: 'treasury-manual-2026-11-07',
        rateEffectiveDate: '2026-11-07',
      }),
    );
    expect(body.lines.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rateReference: null, rateEffectiveDate: null }),
      ]),
    );
    expect(new Headers(save?.[1]?.headers).get('x-kemfai-company-id')).toBe('company-a1');
  });

  it('blocks missing caller FX provenance without deriving a rate or base amount', async () => {
    const fetchMock = jest.fn(successfulFetch);
    global.fetch = fetchMock as unknown as typeof fetch;
    const Draft = draftComposer();
    render(<Draft />);
    await addLines(1);
    fireEvent.change(screen.getByTestId('draft-line-0-transaction-currency'), {
      target: { value: 'USD' },
    });
    setInput('draft-line-0-transaction-debit', '1.234567890123');
    setInput('draft-line-0-base-debit', '4.567890123456');
    fireEvent.click(screen.getByTestId('draft-save'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/rate|reference|effective/i);
    expect(screen.getByTestId('draft-line-0-rate-reference')).toHaveFocus();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url.includes('/drafts') && init?.method === 'POST',
      ),
    ).toBe(false);
    const line = screen.getByTestId('draft-line-0');
    expect(within(line).getByDisplayValue('1.234567890123')).toBeInTheDocument();
    expect(within(line).getByDisplayValue('4.567890123456')).toBeInTheDocument();
    expect(within(line).queryByLabelText(/^.*rate$/i)).not.toBeInTheDocument();
  });

  it('renders exact totals, snapshots, all issue groups, and an explicit not-posting preview', async () => {
    global.fetch = jest.fn(successfulFetch) as unknown as typeof fetch;
    const Draft = draftComposer();
    render(<Draft />);
    await addLines(1);
    fireEvent.click(screen.getByTestId('draft-save'));
    fireEvent.click(await screen.findByTestId('draft-validate'));
    const preview = await screen.findByTestId('draft-preview');
    for (const text of [
      '100.00009',
      '99.99000',
      'AED-native-v3',
      'USD-native-v8',
      'BASE_TOTALS_UNBALANCED',
      'JOURNAL_INACTIVE',
      'AMOUNT_SCALE_EXCEEDS_METADATA',
    ]) {
      expect(preview).toHaveTextContent(text);
    }
    expect(preview).toHaveTextContent(/not posting|does not post|no ledger effect/i);
    expect(preview).toHaveAttribute('data-ledger-effect', 'none');
    expect(screen.queryByRole('button', { name: /^.*post.*$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/valid_for_post/i)).not.toBeInTheDocument();
  });

  it('accepts validation issues whose optional resource fields are omitted', async () => {
    const validation = validationResponse();
    delete (validation.result.errors[0] as { resourceId?: string | null }).resourceId;
    global.fetch = jest.fn((url: string, init?: RequestInit) =>
      url.endsWith('/validate')
        ? Promise.resolve(response(200, validation, { etag: '"2"' }))
        : successfulFetch(url, init),
    ) as unknown as typeof fetch;
    const Draft = draftComposer();
    render(<Draft />);
    await addLines(1);
    fireEvent.click(screen.getByTestId('draft-save'));
    fireEvent.click(await screen.findByTestId('draft-validate'));
    expect(await screen.findByTestId('draft-preview')).toHaveTextContent('BASE_TOTALS_UNBALANCED');
  });

  it('suppresses rapid double submit while one save is pending', async () => {
    let resolveSave: ((value: ReturnType<typeof response>) => void) | undefined;
    const pending = new Promise<ReturnType<typeof response>>((resolve) => {
      resolveSave = resolve;
    });
    const fetchMock = jest.fn((url: string, init?: RequestInit) =>
      url === '/api/accounting/v1/drafts' && init?.method === 'POST'
        ? pending
        : successfulFetch(url, init),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const Draft = draftComposer();
    render(<Draft />);
    await addLines(1);
    const save = screen.getByTestId('draft-save');
    fireEvent.click(save);
    fireEvent.click(save);
    expect(save).toBeDisabled();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === '/api/accounting/v1/drafts' && init?.method === 'POST',
      ),
    ).toHaveLength(1);
    resolveSave?.(
      response(
        201,
        { resource: { id: draftId, version: 1, status: 'draft', ledgerEffect: 'none' } },
        { etag: '"1"' },
      ),
    );
    expect(await screen.findByTestId('draft-saved')).toHaveTextContent(/none/i);
  });

  it('preserves five-line edits and focuses stale configuration after a 412 update', async () => {
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === `/api/accounting/v1/drafts/${draftId}` && init?.method === 'PUT')
        return Promise.resolve(
          response(412, {
            code: 'CONFIGURATION_STALE',
            issues: [
              { code: 'CONFIGURATION_STALE', field: 'lines.2.currencyConfigurationVersion' },
            ],
          }),
        );
      return successfulFetch(url, init);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const Draft = draftComposer();
    render(<Draft />);
    await addLines(5);
    setInput('draft-line-2-transaction-debit', '333.33000');
    fireEvent.click(screen.getByTestId('draft-save'));
    await screen.findByTestId('draft-saved');
    setInput('draft-line-4-transaction-credit', '333.33000');
    fireEvent.click(screen.getByTestId('draft-save'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/stale|configuration|changed/i);
    expect(screen.getByTestId('draft-line-2-transaction-debit')).toHaveValue('333.33000');
    expect(screen.getByTestId('draft-line-4-transaction-credit')).toHaveValue('333.33000');
    expect(screen.getByTestId('draft-line-2-transaction-currency')).toHaveFocus();
    const update = fetchMock.mock.calls.find(
      ([url, init]) => url === `/api/accounting/v1/drafts/${draftId}` && init?.method === 'PUT',
    );
    expect(new Headers(update?.[1]?.headers).get('if-match')).toBe('"1"');
  });

  it.each(['en', 'ar'] as const)(
    'preserves exact values and identifiers in %s direction',
    async (locale) => {
      activeLocale = locale;
      global.fetch = jest.fn(successfulFetch) as unknown as typeof fetch;
      const Draft = draftComposer();
      render(<Draft />);
      await addLines(1);
      expect(screen.getByTestId('draft-composer')).toHaveAttribute(
        'dir',
        locale === 'ar' ? 'rtl' : 'ltr',
      );
      setInput('draft-line-0-transaction-debit', '123.45000');
      expect(screen.getByTestId('draft-line-0-transaction-debit')).toHaveValue('123.45000');
      expect(screen.getByTestId('draft-line-0')).toHaveAttribute('data-account-id', account.id);
    },
  );
});
