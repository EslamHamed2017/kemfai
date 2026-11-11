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
  '../../src/app/(workspace)/accounting/dimensions/dimensions-screen',
  () => ({
    DimensionsScreen: () => null,
  }),
);

import { SESSION_COOKIE } from '../../src/lib/auth/cookies';
import DimensionsPage from '../../src/app/(workspace)/accounting/dimensions/page';
import { DimensionsScreen } from '../../src/app/(workspace)/accounting/dimensions/dimensions-screen';

describe('Accounting dimensions workspace page (T098)', () => {
  beforeEach(() => {
    cookieStore.clear();
    redirectMock.mockClear();
  });

  it('redirects an unauthenticated request to login with the exact dimensions return path', async () => {
    await expect(DimensionsPage({})).rejects.toThrow(
      'NEXT_REDIRECT:/auth/login?returnTo=%2Faccounting%2Fdimensions',
    );
    expect(redirectMock).toHaveBeenCalledWith(
      '/auth/login?returnTo=%2Faccounting%2Fdimensions',
    );
  });

  it('mounts the dimensions screen with company context for an authenticated session', async () => {
    cookieStore.set(SESSION_COOKIE, 'session-id');

    const result = (await DimensionsPage({
      searchParams: Promise.resolve({ companyId: 'company-a1' }),
    })) as ReactElement<{ companyId?: string }>;

    expect(result.type).toBe(DimensionsScreen);
    expect(result.props.companyId).toBe('company-a1');
  });
});
