import type { ComponentType } from 'react';
import axe from 'axe-core';
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

type JournalsCurrenciesModule = {
  JournalsCurrenciesScreen: ComponentType<{ companyId?: string }>;
};

function journalsCurrenciesScreen() {
  const path =
    '../../src/app/(workspace)/accounting/journals-currencies/' + 'journals-currencies-screen';
  return jest.requireActual<JournalsCurrenciesModule>(path).JournalsCurrenciesScreen;
}

function response(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  };
}

const journal = {
  id: '81818181-1111-4111-8111-111111111111',
  code: 'GEN',
  name: { en: 'General journal', ar: 'دفتر اليومية العام' },
  journalType: 'general',
  active: true,
  version: 3,
};
const inactiveJournal = {
  id: '81818181-2222-4222-8222-222222222222',
  code: 'OLD',
  name: { en: 'Legacy journal', ar: 'دفتر اليومية السابق' },
  journalType: 'general',
  active: false,
  version: 8,
};
const baseCurrency = {
  currencyCode: 'AED',
  enabled: true,
  isBase: true,
  nativeDecimalPlaces: 2,
  nativeMetadataVersion: 'AED-native-v1',
  version: 4,
};
const foreignCurrency = {
  currencyCode: 'USD',
  enabled: false,
  isBase: false,
  nativeDecimalPlaces: 2,
  nativeMetadataVersion: 'USD-native-v7',
  version: 2,
};
const page = (items: unknown[]) => ({ items, nextCursor: null });

function successfulFetch(url: string, init?: RequestInit) {
  if (init?.method === 'POST') {
    return Promise.resolve(response(201, { resource: journal }, { etag: '"3"' }));
  }
  if (init?.method === 'PATCH') {
    return Promise.resolve(
      response(200, { resource: { ...journal, version: 4 } }, { etag: '"4"' }),
    );
  }
  if (init?.method === 'PUT') {
    return Promise.resolve(
      response(
        200,
        { resource: { ...foreignCurrency, enabled: true, version: 3 } },
        { etag: '"3"' },
      ),
    );
  }
  if (url.includes('/journals')) {
    return Promise.resolve(response(200, page([journal, inactiveJournal])));
  }
  if (url.includes('/currencies')) {
    return Promise.resolve(response(200, page([baseCurrency, foreignCurrency])));
  }
  return Promise.resolve(response(404, {}));
}

beforeEach(() => {
  activeLocale = 'en';
  jest.restoreAllMocks();
});

afterEach(() => {
  document.documentElement.style.fontSize = '';
});

describe('Accounting journals and currencies UI (T112)', () => {
  it('announces loading and disables journal and currency mutations', () => {
    global.fetch = jest.fn(() => new Promise(() => undefined)) as unknown as typeof fetch;
    const Screen = journalsCurrenciesScreen();
    render(<Screen companyId="company-a1" />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('journal-create')).toBeDisabled();
    expect(screen.getByTestId('currency-enable-USD')).toBeDisabled();
  });

  it('shows localized empty journal and currency states without manufactured masters', async () => {
    global.fetch = jest.fn(async () => response(200, page([]))) as unknown as typeof fetch;
    const Screen = journalsCurrenciesScreen();
    render(<Screen />);

    expect(await screen.findByTestId('accounting-journals-empty')).toBeInTheDocument();
    expect(screen.getByTestId('accounting-currencies-empty')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /GEN|AED/ })).not.toBeInTheDocument();
  });

  it('announces a recoverable collection error and retries both collections', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response(503, {}))
      .mockResolvedValueOnce(response(503, {}))
      .mockImplementation(successfulFetch);
    global.fetch = fetchMock as unknown as typeof fetch;
    const Screen = journalsCurrenciesScreen();
    render(<Screen />);

    expect(await screen.findByRole('alert')).toHaveAttribute('aria-live', 'assertive');
    fireEvent.click(screen.getByTestId('journals-currencies-retry'));
    await screen.findByRole('table', { name: /journal/i });
    expect(screen.getByRole('table', { name: /currenc/i })).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('renders active and historical journals while keeping native currency metadata read-only', async () => {
    global.fetch = jest.fn(successfulFetch) as unknown as typeof fetch;
    const Screen = journalsCurrenciesScreen();
    render(<Screen />);

    const journals = await screen.findByRole('table', { name: /journal/i });
    expect(within(journals).getByRole('row', { name: /GEN.*General journal/i })).toHaveAttribute(
      'data-active',
      'true',
    );
    expect(within(journals).getByRole('row', { name: /OLD.*Legacy journal/i })).toHaveAttribute(
      'data-historical',
      'true',
    );

    const currencies = screen.getByRole('table', { name: /currenc/i });
    const aed = within(currencies).getByRole('row', { name: /AED/ });
    expect(aed).toHaveTextContent(/2/);
    expect(aed).toHaveTextContent(/AED-native-v1/);
    expect(within(aed).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/decimal.*AED|AED.*decimal/i)).not.toBeInTheDocument();
  });

  it('opens journal creation from the keyboard and submits bilingual values through the BFF', async () => {
    const fetchMock = jest.fn(successfulFetch);
    global.fetch = fetchMock as unknown as typeof fetch;
    const Screen = journalsCurrenciesScreen();
    render(<Screen companyId="company-a1" />);

    const create = await screen.findByTestId('journal-create');
    create.focus();
    fireEvent.keyDown(create, { key: 'Enter' });
    const dialog = await screen.findByRole('dialog', { name: /journal/i });
    const code = within(dialog).getByLabelText(/code/i);
    expect(code).toHaveFocus();
    fireEvent.change(code, { target: { value: 'ADJ' } });
    fireEvent.change(within(dialog).getByLabelText(/name.*en|english name/i), {
      target: { value: 'Adjustments' },
    });
    fireEvent.change(within(dialog).getByLabelText(/name.*ar|arabic name/i), {
      target: { value: 'التسويات' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /save|create/i }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
    );
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/accounting/v1/journals');
    expect(new Headers(post?.[1]?.headers).get('x-kemfai-company-id')).toBe('company-a1');
    expect(new Headers(post?.[1]?.headers).get('idempotency-key')).toBeTruthy();
    expect(JSON.parse(String(post?.[1]?.body))).toEqual(
      expect.objectContaining({
        code: 'ADJ',
        name: { en: 'Adjustments', ar: 'التسويات' },
      }),
    );
  });

  it('uses create-only star then exact ETag updates without sending immutable currency fields', async () => {
    const fetchMock = jest.fn(successfulFetch);
    global.fetch = fetchMock as unknown as typeof fetch;
    const Screen = journalsCurrenciesScreen();
    render(<Screen />);

    fireEvent.click(await screen.findByTestId('currency-enable-USD'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true),
    );
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put?.[0]).toBe('/api/accounting/v1/currencies/USD');
    expect(new Headers(put?.[1]?.headers).get('if-match')).toBe('"2"');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ enabled: true });
    expect(String(put?.[1]?.body)).not.toMatch(/nativeDecimalPlaces|nativeMetadataVersion|isBase/);
  });

  it('preserves journal edits and restores focus after an announced stale conflict', async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return response(412, { code: 'STALE_VERSION' });
      return successfulFetch(url, init);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const Screen = journalsCurrenciesScreen();
    render(<Screen />);

    fireEvent.click(await screen.findByTestId(`journal-edit-${journal.id}`));
    const englishName = screen.getByLabelText(/name.*en|english name/i);
    fireEvent.change(englishName, { target: { value: 'Unsaved journal edit' } });
    fireEvent.click(screen.getByTestId('journal-save'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/stale|conflict|changed/i);
    expect(englishName).toHaveValue('Unsaved journal edit');
    expect(englishName).toHaveFocus();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(new Headers(patch?.[1]?.headers).get('if-match')).toBe('"3"');
  });

  it.each(['en', 'ar'] as const)(
    'renders localized names and preserves identifiers in %s direction',
    async (locale) => {
      activeLocale = locale;
      global.fetch = jest.fn(successfulFetch) as unknown as typeof fetch;
      const Screen = journalsCurrenciesScreen();
      render(<Screen />);

      const surface = await screen.findByTestId('accounting-journals-currencies');
      expect(surface).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      const localizedName = locale === 'ar' ? 'دفتر اليومية العام' : 'General journal';
      const row = screen.getByRole('row', { name: new RegExp(`GEN.*${localizedName}`) });
      expect(row).toHaveAttribute('data-resource-id', journal.id);
      expect(screen.getByText('AED')).toHaveAttribute('data-currency-code', 'AED');
    },
  );

  it('has no axe violations on the populated English surface', async () => {
    global.fetch = jest.fn(successfulFetch) as unknown as typeof fetch;
    const Screen = journalsCurrenciesScreen();
    const { container } = render(<Screen />);
    await screen.findByRole('table', { name: /journal/i });

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it('remains keyboard-operable at 200% zoom without fixed-width clipping', async () => {
    document.documentElement.style.fontSize = '32px';
    global.fetch = jest.fn(successfulFetch) as unknown as typeof fetch;
    const Screen = journalsCurrenciesScreen();
    render(<Screen />);

    const surface = await screen.findByTestId('accounting-journals-currencies');
    expect(surface.getAttribute('style') ?? '').not.toMatch(/width:\s*\d+px/i);
    const create = screen.getByTestId('journal-create');
    create.focus();
    fireEvent.keyDown(create, { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: /journal/i })).toBeVisible();
  });
});
