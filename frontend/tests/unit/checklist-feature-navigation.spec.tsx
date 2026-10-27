import { render, screen } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';

import { ChecklistScreen } from '../../src/app/(onboarding)/checklist/checklist-screen';
import type { ChecklistState } from '../../src/lib/checklist-state';

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));
jest.mock('@carbon/react', () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  InlineLoading: ({ description }: { description: string }) => <p>{description}</p>,
  InlineNotification: ({ title }: { title: string }) => <p>{title}</p>,
  Link: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Tile: ({
    children,
    ...props
  }: { children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}));
jest.mock('../../src/components/locale-switcher', () => ({
  LocaleSwitcher: () => <button>locale</button>,
}));
jest.mock('../../src/components/sign-out-button', () => ({
  SignOutButton: () => <button>sign out</button>,
}));

const state: ChecklistState = {
  customerAdded: false,
  bankAdded: false,
  productAdded: false,
  firstInvoiceReady: false,
  gatedOnSubscriptionActivation: false,
};

const FlagAwareChecklist = ChecklistScreen as unknown as ComponentType<{
  initialState: ChecklistState;
  moduleSelectionAvailable: boolean;
}>;

function moduleTargets(): HTMLAnchorElement[] {
  return screen
    .getAllByRole('link')
    .filter((link): link is HTMLAnchorElement => link instanceof HTMLAnchorElement)
    .filter((link) => {
      const pathname = new URL(link.href).pathname;
      return pathname === '/modules' || pathname.startsWith('/modules/');
    });
}

describe('T112 checklist cross-surface feature navigation', () => {
  it('removes module deep links from the DOM when module selection is unavailable', () => {
    const { rerender } = render(
      <FlagAwareChecklist initialState={state} moduleSelectionAvailable={false} />,
    );

    expect(moduleTargets()).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'items.firstInvoice.action' })).toHaveAttribute(
      'href',
      '/billing',
    );

    rerender(<FlagAwareChecklist initialState={state} moduleSelectionAvailable />);
    expect(moduleTargets().map((link) => link.getAttribute('href'))).toEqual([
      '/modules#module.sales',
      '/modules#module.accounting',
      '/modules#module.inventory',
    ]);
  });
});
