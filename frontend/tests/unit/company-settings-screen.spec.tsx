import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CompanySettingsScreen } from '../../src/app/(onboarding)/company-settings/company-settings-screen';
import ar from '../../src/locales/ar/common.json';
import en from '../../src/locales/en/common.json';

let activeLocale: 'en' | 'ar' = 'en';

jest.mock('next-intl', () => ({
  useLocale: () => activeLocale,
  useTranslations:
    (namespace: string) =>
    (key: string): string => {
      const messages = activeLocale === 'ar' ? ar : en;
      const value = `${namespace}.${key}`
        .split('.')
        .reduce<unknown>((acc, segment) => (acc as Record<string, unknown>)[segment], messages);
      if (typeof value !== 'string') throw new Error(`Missing translation for ${namespace}.${key}`);
      return value;
    },
}));

const settings = {
  country: 'AE',
  legal_name: 'Acme LLC',
  trade_name: 'Acme',
  base_currency: 'AED',
  fiscal_year_start_month: 1,
  fiscal_year_start_day: 1,
  vat_tax_registration: '100000000000003',
  industry: 7,
  accounting_setup_template: 'standard',
};

function response(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  activeLocale = 'en';
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('loads every completed-company field and saves edits through settings without calling the wizard', async () => {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return response(200);
    return response(200, { values: settings, setupComplete: true });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<CompanySettingsScreen />);

  const legalName = await screen.findByLabelText(en.setupWizard.fields.legal_name.label);
  expect(legalName).toHaveValue('Acme LLC');
  expect(screen.getByLabelText(en.setupWizard.fields.country.label)).toHaveValue('AE');
  expect(screen.getByLabelText(en.setupWizard.fields.base_currency.label)).toHaveValue('AED');
  expect(screen.getByLabelText(en.setupWizard.fields.fiscal_year_start_month.label)).toHaveValue(
    '1',
  );
  expect(screen.getByLabelText(en.setupWizard.fields.fiscal_year_start_day.label)).toHaveValue(1);
  expect(screen.getByLabelText(en.setupWizard.fields.vat_tax_registration.label)).toHaveValue(
    '100000000000003',
  );
  expect(screen.getByLabelText(en.setupWizard.fields.industry.label)).toHaveValue(7);
  expect(screen.getByLabelText(en.setupWizard.fields.accounting_setup_template.label)).toHaveValue(
    'standard',
  );

  fireEvent.change(legalName, { target: { value: 'Acme Holdings LLC' } });
  fireEvent.submit(screen.getByRole('form', { name: en.companySettings.formLabel }));

  await waitFor(() => expect(screen.getByTestId('company-settings-saved')).toBeInTheDocument());
  const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(putCall?.[0]).toBe('/api/companies/current/settings');
  expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
    values: { legal_name: 'Acme Holdings LLC' },
  });
  expect(new Headers(putCall?.[1]?.headers).get('idempotency-key')).toBeTruthy();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/setup'))).toBe(false);
});

test('renders the canonical pre-completion response as a localized path to the wizard', async () => {
  global.fetch = jest.fn(async () =>
    response(409, { statusCode: 409, message: 'Setup incomplete', setupComplete: false }),
  ) as unknown as typeof fetch;

  render(<CompanySettingsScreen />);

  const state = await screen.findByTestId('company-settings-setup-incomplete');
  expect(state).toHaveTextContent(en.companySettings.errors.setupIncomplete);
  expect(screen.getByRole('link', { name: en.companySettings.actions.openWizard })).toHaveAttribute(
    'href',
    '/setup-wizard',
  );
});

test('preserves an edited field and localizes its server-side validation error', async () => {
  global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return response(422, { statusCode: 422, message: 'legal_name is required.' });
    }
    return response(200, { values: settings, setupComplete: true });
  }) as unknown as typeof fetch;

  render(<CompanySettingsScreen />);
  const legalName = await screen.findByLabelText(en.setupWizard.fields.legal_name.label);
  fireEvent.change(legalName, { target: { value: '' } });
  fireEvent.click(screen.getByTestId('company-settings-save'));

  expect(await screen.findByText(en.setupWizard.fields.legal_name.error)).toBeInTheDocument();
  expect(legalName).toHaveValue('');
});

test('uses Arabic labels and an RTL form surface', async () => {
  activeLocale = 'ar';
  global.fetch = jest.fn(async () =>
    response(200, { values: settings, setupComplete: true }),
  ) as unknown as typeof fetch;

  render(<CompanySettingsScreen />);

  const main = await screen.findByTestId('company-settings');
  expect(main).toHaveAttribute('dir', 'rtl');
  expect(screen.getByRole('heading', { name: ar.companySettings.title })).toBeInTheDocument();
  expect(screen.getByLabelText(ar.setupWizard.fields.legal_name.label)).toHaveValue('Acme LLC');
});

test('reuses an idempotency key for an ambiguous retry and rotates it after the payload changes', async () => {
  const keys: Array<string | null> = [];
  let putCalls = 0;
  global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      putCalls += 1;
      keys.push(new Headers(init.headers).get('idempotency-key'));
      if (putCalls < 3) throw new Error('response lost');
      return response(200);
    }
    return response(200, { values: settings, setupComplete: true });
  }) as unknown as typeof fetch;

  render(<CompanySettingsScreen />);
  const legalName = await screen.findByLabelText(en.setupWizard.fields.legal_name.label);
  fireEvent.change(legalName, { target: { value: 'First edit' } });

  fireEvent.click(screen.getByTestId('company-settings-save'));
  await screen.findByTestId('company-settings-general-error');
  fireEvent.click(screen.getByTestId('company-settings-save'));
  await waitFor(() => expect(putCalls).toBe(2));
  await waitFor(() => expect(screen.getByTestId('company-settings-save')).not.toBeDisabled());
  expect(keys[1]).toBe(keys[0]);

  fireEvent.change(screen.getByLabelText(en.setupWizard.fields.legal_name.label), {
    target: { value: 'A different edit' },
  });
  fireEvent.click(screen.getByTestId('company-settings-save'));
  await screen.findByTestId('company-settings-saved');
  expect(keys[2]).not.toBe(keys[1]);
});

test('submits only dirty fields so a stale form cannot overwrite unrelated concurrent edits', async () => {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return response(200);
    return response(200, { values: settings, setupComplete: true });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<CompanySettingsScreen />);
  const save = await screen.findByTestId('company-settings-save');
  expect(save).toBeDisabled();

  fireEvent.change(screen.getByLabelText(en.setupWizard.fields.trade_name.label), {
    target: { value: 'Fresh trade name' },
  });
  fireEvent.click(save);

  await screen.findByTestId('company-settings-saved');
  const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
    values: { trade_name: 'Fresh trade name' },
  });
  expect(save).toBeDisabled();
});

test('applies the authoritative settings returned after a successful save', async () => {
  const authoritative = { ...settings, legal_name: 'ACME NORMALIZED' };
  global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return response(200, { values: authoritative, setupComplete: true });
    }
    return response(200, { values: settings, setupComplete: true });
  }) as unknown as typeof fetch;

  render(<CompanySettingsScreen />);
  const legalName = await screen.findByLabelText(en.setupWizard.fields.legal_name.label);
  fireEvent.change(legalName, { target: { value: '  Acme normalized  ' } });
  fireEvent.click(screen.getByTestId('company-settings-save'));

  await screen.findByTestId('company-settings-saved');
  expect(legalName).toHaveValue('ACME NORMALIZED');
  expect(screen.getByTestId('company-settings-save')).toBeDisabled();
});

test('rejects a malformed successful response instead of rendering an editable empty form', async () => {
  global.fetch = jest.fn(async () =>
    response(200, { values: settings }),
  ) as unknown as typeof fetch;

  render(<CompanySettingsScreen />);

  expect(await screen.findByTestId('company-settings-recoverable')).toHaveTextContent(
    en.companySettings.errors.unavailable,
  );
  expect(screen.queryByRole('form')).not.toBeInTheDocument();
});
