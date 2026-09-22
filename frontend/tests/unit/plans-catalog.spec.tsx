import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import en from '@/locales/en/common.json';
import ar from '@/locales/ar/common.json';
import { PlansCatalog } from '@/app/(public)/plans/plans-catalog';

let locale = 'en';
const get = jest.fn();

jest.mock('next-intl', () => ({
  useLocale: () => locale,
  useTranslations: (namespace: 'plans') => {
    const messages = (locale === 'ar' ? ar : en)[namespace] as Record<string, string>;
    return (key: string, values?: Record<string, string>) =>
      Object.entries(values ?? {}).reduce(
        (copy, [name, value]) => copy.replace(`{${name}}`, value),
        messages[key],
      );
  },
}));

jest.mock('../../src/lib/api-client', () => ({
  getBrowserApiClient: () => ({ GET: get }),
}));

const plan = {
  id: '11111111-1111-1111-1111-111111111111',
  name: { en: 'Growth', ar: 'النمو' },
  monthlyPrice: 100,
  annualPrice: 1000,
  currency: 'USD',
  features: [
    { key: 'users', name: { en: 'Users', ar: 'المستخدمون' }, limitValue: 25 },
    { key: 'accounting', name: { en: 'Accounting', ar: 'المحاسبة' }, limitValue: null },
  ],
};

describe('PlansCatalog (T036)', () => {
  beforeEach(() => {
    locale = 'en';
    get.mockReset();
  });

  it('renders loading, pricing/features, and carries the keyboard-selected cycle to signup', async () => {
    let resolve!: (value: unknown) => void;
    get.mockReturnValue(new Promise((done) => (resolve = done)));
    render(<PlansCatalog />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading plans');

    resolve({ data: [plan] });
    expect(await screen.findByRole('heading', { name: 'Growth' })).toBeInTheDocument();
    expect(screen.getByText('Users — Limit: 25')).toBeInTheDocument();
    expect(screen.getByText('Accounting')).toBeInTheDocument();
    expect(screen.queryByText(/Accounting.*Limit/)).not.toBeInTheDocument();
    const annual = screen.getByRole('radio', { name: 'Annual' });
    annual.focus();
    fireEvent.click(annual);
    expect(annual).toBeChecked();
    expect(screen.getByRole('link', { name: 'Choose Growth' })).toHaveAttribute(
      'href',
      `/signup?plan=${plan.id}&cycle=annual`,
    );
  });

  it('uses data-driven Arabic plan and feature names in an RTL container', async () => {
    locale = 'ar';
    get.mockResolvedValue({ data: [plan] });
    const { container } = render(<PlansCatalog />);

    expect(await screen.findByRole('heading', { name: 'النمو' })).toBeInTheDocument();
    expect(screen.getByText('المستخدمون — الحد: ٢٥')).toBeInTheDocument();
    expect(screen.getByText('المحاسبة')).toBeInTheDocument();
    expect(screen.queryByText('Growth')).not.toBeInTheDocument();
    expect(container.querySelector('main')).toHaveAttribute('dir', 'rtl');
  });

  it('renders a localized empty state', async () => {
    get.mockResolvedValue({ data: [] });
    render(<PlansCatalog />);
    expect(await screen.findByText(/No plans are available/)).toBeInTheDocument();
  });

  it('renders an actionable error and retries successfully', async () => {
    get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: [plan] });
    render(<PlansCatalog />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { name: 'Growth' })).toBeInTheDocument();
  });
});
