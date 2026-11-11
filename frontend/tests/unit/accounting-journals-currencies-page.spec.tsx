import type { ReactElement } from 'react';

const cookieStore = new Map<string, string>();
const redirectMock = jest.fn((destination: string) => {
  throw new Error(`NEXT_REDIRECT:${destination}`);
});

jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieStore.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

jest.mock('next/navigation', () => ({ redirect: (destination: string) => redirectMock(destination) }));

jest.mock(
  '../../src/app/(workspace)/accounting/journals-currencies/journals-currencies-screen',
  () => ({
    JournalsCurrenciesScreen: () => null,
  }),
);

import { SESSION_COOKIE } from '../../src/lib/auth/cookies';
import JournalsCurrenciesPage from '../../src/app/(workspace)/accounting/journals-currencies/page';
import { JournalsCurrenciesScreen } from '../../src/app/(workspace)/accounting/journals-currencies/journals-currencies-screen';

describe('Accounting journals and currencies workspace page (T134)', () => {
  beforeEach(() => {
    cookieStore.clear();
    redirectMock.mockClear();
  });

  it('redirects an unauthenticated request to login with the exact workspace return path', async () => {
    await expect(JournalsCurrenciesPage({})).rejects.toThrow(
      'NEXT_REDIRECT:/auth/login?returnTo=%2Faccounting%2Fjournals-currencies',
    );
    expect(redirectMock).toHaveBeenCalledWith(
      '/auth/login?returnTo=%2Faccounting%2Fjournals-currencies',
    );
  });

  it('mounts the workspace with company context for an authenticated session', async () => {
    cookieStore.set(SESSION_COOKIE, 'session-id');

    const result = (await JournalsCurrenciesPage({
      searchParams: Promise.resolve({ companyId: 'company-a1' }),
    })) as ReactElement<{ companyId?: string }>;

    expect(result.type).toBe(JournalsCurrenciesScreen);
    expect(result.props.companyId).toBe('company-a1');
  });
});
