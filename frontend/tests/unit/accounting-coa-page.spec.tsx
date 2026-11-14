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
  '../../src/app/(workspace)/accounting/chart-of-accounts/chart-of-accounts-screen',
  () => ({
    ChartOfAccountsScreen: () => null,
  }),
);

import { SESSION_COOKIE } from '../../src/lib/auth/cookies';
import ChartOfAccountsPage from '../../src/app/(workspace)/accounting/chart-of-accounts/page';
import { ChartOfAccountsScreen } from '../../src/app/(workspace)/accounting/chart-of-accounts/chart-of-accounts-screen';

describe('Chart of accounts workspace page (T062)', () => {
  beforeEach(() => {
    cookieStore.clear();
    redirectMock.mockClear();
  });

  it('redirects an unauthenticated request to login with the exact workspace return path', async () => {
    await expect(ChartOfAccountsPage({})).rejects.toThrow(
      'NEXT_REDIRECT:/auth/login?returnTo=%2Faccounting%2Fchart-of-accounts',
    );
    expect(redirectMock).toHaveBeenCalledWith(
      '/auth/login?returnTo=%2Faccounting%2Fchart-of-accounts',
    );
  });

  it('mounts the client screen for an authenticated workspace session', async () => {
    cookieStore.set(SESSION_COOKIE, 'session-id');

    const result = (await ChartOfAccountsPage({})) as ReactElement;

    expect(result.type).toBe(ChartOfAccountsScreen);
  });
});
