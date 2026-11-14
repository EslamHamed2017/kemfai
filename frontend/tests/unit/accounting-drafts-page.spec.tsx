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
  '../../src/app/(workspace)/accounting/drafts/draft-composer',
  () => ({
    DraftComposer: () => null,
  }),
);

import { SESSION_COOKIE } from '../../src/lib/auth/cookies';
import DraftsPage from '../../src/app/(workspace)/accounting/drafts/page';
import { DraftComposer } from '../../src/app/(workspace)/accounting/drafts/draft-composer';

describe('Accounting drafts workspace page (T064)', () => {
  beforeEach(() => {
    cookieStore.clear();
    redirectMock.mockClear();
  });

  it('redirects an unauthenticated request to login with the exact drafts return path', async () => {
    await expect(DraftsPage({})).rejects.toThrow(
      'NEXT_REDIRECT:/auth/login?returnTo=%2Faccounting%2Fdrafts',
    );
    expect(redirectMock).toHaveBeenCalledWith(
      '/auth/login?returnTo=%2Faccounting%2Fdrafts',
    );
  });

  it('mounts the non-posting draft composer for an authenticated workspace session', async () => {
    cookieStore.set(SESSION_COOKIE, 'session-id');

    const result = (await DraftsPage({})) as ReactElement;

    expect(result.type).toBe(DraftComposer);
  });
});
