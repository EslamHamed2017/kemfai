import { render, screen } from '@testing-library/react';
import { SupportAccessScreen } from '../../src/app/(onboarding)/support-access/support-access-screen';

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) =>
    ({
      title: 'Temporary support access',
      expiry: 'Access expires',
      empty: 'No support access history yet.',
    })[key] ?? key,
}));
jest.mock('@carbon/react', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  InlineLoading: ({ description }: { description: string }) => <p>{description}</p>,
  InlineNotification: ({ title }: { title: string }) => <p>{title}</p>,
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Tile: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}));
jest.mock('../../src/components/locale-switcher', () => ({
  LocaleSwitcher: () => <button>locale</button>,
}));
jest.mock('../../src/components/sign-out-button', () => ({
  SignOutButton: () => <button>sign out</button>,
}));

describe('Support access owner UI (T087/T091 RED)', () => {
  it('renders mandatory expiry, empty history and revoke-capable history semantics', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as Response) as jest.Mock;
    render(<SupportAccessScreen initialGrants={[]} />);
    expect(screen.getByRole('heading', { name: /temporary support access/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/expires/i)).toBeRequired();
    expect(await screen.findByText(/no support access history/i)).toBeInTheDocument();
  });
});
