import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  makeDraft,
  readDraft,
  writeDraft,
} from '../../src/app/(onboarding)/setup-wizard/draft-storage';
import { signOut } from '../../src/lib/auth/sign-out';
import { SignOutButton } from '../../src/components/sign-out-button';
import { SetupWizardScreen } from '../../src/app/(onboarding)/setup-wizard/setup-wizard-screen';
import en from '../../src/locales/en/common.json';

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations:
    (namespace: string) =>
    (key: string): string => {
      const value = `${namespace}.${key}`
        .split('.')
        .reduce<unknown>((acc, segment) => (acc as Record<string, unknown>)[segment], en);
      if (typeof value !== 'string') {
        throw new Error(`Missing translation for ${namespace}.${key}`);
      }
      return value;
    },
}));

// jsdom's test environment has no global `Response` constructor, so build a minimal
// fetch-response-shaped object instead of `new Response(...)` (signOut only ever calls
// `.json()` on what fetch resolves to).
const jsonResponse = (body: unknown, status: number) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/**
 * T056 point 3 (corrective) — the real sign-out handler: clears ONLY the
 * `kemfai:setup-wizard:` sessionStorage namespace (never unrelated browser storage) and
 * only once the logout BFF proves local cleanup was attempted, POSTs to the same-origin
 * logout BFF route, and hard-navigates to the existing login page ONLY on a
 * provider-confirmed outcome (asserted through `signOut`'s injectable `navigate` seam,
 * never jsdom's non-configurable `window.location`). A provider-unconfirmed outcome must
 * never be reported as a safe account switch and must never navigate.
 */
describe('signOut (T056 point 3)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    (global.fetch as unknown) = jest.fn(async () => jsonResponse({ outcome: 'confirmed' }, 200));
  });

  it('on provider-confirmed success: removes the setup-wizard draft namespace, posts to the logout BFF, and hard-navigates to login', async () => {
    writeDraft(makeDraft('scope-alpha', 1, 'identity', { legal_name: 'Alpha Secret' }));
    window.sessionStorage.setItem('unrelated:key', 'keep-me');
    const navigate = jest.fn();

    const outcome = await signOut(navigate);

    expect(outcome).toBe('confirmed');
    expect(readDraft()).toBeNull();
    expect(window.sessionStorage.getItem('unrelated:key')).toBe('keep-me');
    expect(global.fetch).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
    expect(navigate).toHaveBeenCalledWith('/auth/login');
  });

  it('on provider-unconfirmed (502) response: still clears the draft namespace (local cleanup was attempted) but never navigates', async () => {
    (global.fetch as unknown) = jest.fn(async () => jsonResponse({ outcome: 'unconfirmed' }, 502));
    writeDraft(makeDraft('scope-alpha', 1, 'identity', { legal_name: 'Alpha Secret' }));
    const navigate = jest.fn();

    const outcome = await signOut(navigate);

    expect(outcome).toBe('unconfirmed');
    expect(readDraft()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('on a network failure (fetch throws): does not clear storage (local cleanup was never confirmed) and never navigates', async () => {
    (global.fetch as unknown) = jest.fn(async () => {
      throw new Error('network down');
    });
    writeDraft(makeDraft('scope-alpha', 1, 'identity', { legal_name: 'Alpha Secret' }));
    const navigate = jest.fn();

    const outcome = await signOut(navigate);

    expect(outcome).toBe('unconfirmed');
    expect(readDraft()).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('on a same-origin-rejection-shaped body (no outcome field, e.g. 403): does not clear storage and never navigates', async () => {
    (global.fetch as unknown) = jest.fn(async () =>
      jsonResponse({ message: 'Forbidden origin' }, 403),
    );
    writeDraft(makeDraft('scope-alpha', 1, 'identity', { legal_name: 'Alpha Secret' }));
    const navigate = jest.fn();

    const outcome = await signOut(navigate);

    expect(outcome).toBe('unconfirmed');
    expect(readDraft()).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('on a malformed (non-JSON) response: does not clear storage and never navigates', async () => {
    (global.fetch as unknown) = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    }));
    writeDraft(makeDraft('scope-alpha', 1, 'identity', { legal_name: 'Alpha Secret' }));
    const navigate = jest.fn();

    const outcome = await signOut(navigate);

    expect(outcome).toBe('unconfirmed');
    expect(readDraft()).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('never includes a token/credential value in any fetch call it makes', async () => {
    const navigate = jest.fn();
    await signOut(navigate);
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.stringify(init)).not.toMatch(/token|secret|password/i);
  });

  it("a real logout -> different-account (Beta) mount never restores Alpha's draft", async () => {
    writeDraft(makeDraft('scope-alpha', 1, 'identity', { legal_name: 'Alpha Secret' }));
    expect(readDraft()).not.toBeNull();

    await signOut(jest.fn());
    expect(readDraft()).toBeNull();

    (global.fetch as unknown) = jest.fn(async (url: string) => {
      if (String(url).includes('/complete')) throw new Error('not used');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          currentStep: 'identity',
          setupComplete: false,
          values: { legal_name: 'Beta Fresh' },
          version: 1,
          stale: false,
          scope: 'scope-beta',
        }),
      };
    });
    render(<SetupWizardScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toHaveValue(
        'Beta Fresh',
      ),
    );
    expect(screen.queryByDisplayValue('Alpha Secret')).not.toBeInTheDocument();
    const remaining = readDraft();
    expect(remaining === null || Object.keys(remaining.dirty).length === 0).toBe(true);
    if (remaining) expect(remaining.scope).toBe('scope-beta');
  });
});

/**
 * T056 point 3 (corrective) — the shared SignOutButton: catches whatever signOut()
 * resolves to, clears its own pending state in every case (success or failure), never
 * produces an unhandled rejection, and surfaces an accessible recovery message on a
 * provider-unconfirmed outcome instead of silently behaving as if the switch were safe.
 * Uses the button's own `navigate` prop seam (not jsdom's real navigation) so no
 * "Not implemented: navigation" console error is produced by this suite.
 */
describe('SignOutButton (T056 point 3)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('invokes the real signOut() handler on click and hard-navigates via its injected seam on confirmed success', async () => {
    (global.fetch as unknown) = jest.fn(async () => jsonResponse({ outcome: 'confirmed' }, 200));
    writeDraft(makeDraft('scope-alpha', 1, 'identity', { legal_name: 'Alpha Secret' }));
    const navigate = jest.fn();
    render(<SignOutButton navigate={navigate} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sign-out-button'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readDraft()).toBeNull();
    expect(global.fetch).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
    expect(navigate).toHaveBeenCalledWith('/auth/login');
    expect(screen.queryByTestId('sign-out-unconfirmed')).not.toBeInTheDocument();
    expect(screen.getByTestId('sign-out-button')).not.toBeDisabled();
  });

  it('shows an accessible recovery message and re-enables the button on a provider-unconfirmed outcome, without an unhandled rejection', async () => {
    (global.fetch as unknown) = jest.fn(async () => jsonResponse({ outcome: 'unconfirmed' }, 502));
    const navigate = jest.fn();
    render(<SignOutButton navigate={navigate} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sign-out-button'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigate).not.toHaveBeenCalled();
    const alert = screen.getByTestId('sign-out-unconfirmed');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert.textContent).toBe(en.app.signOutUnconfirmed);
    expect(screen.getByTestId('sign-out-button')).not.toBeDisabled();
  });

  it('clears pending state and shows the recovery message even on a network failure (never an unhandled rejection)', async () => {
    (global.fetch as unknown) = jest.fn(async () => {
      throw new Error('network down');
    });
    const navigate = jest.fn();
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    render(<SignOutButton navigate={navigate} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('sign-out-button'));
      await Promise.resolve();
      await Promise.resolve();
    });

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('sign-out-unconfirmed')).toBeInTheDocument();
    expect(screen.getByTestId('sign-out-button')).not.toBeDisabled();
  });
});
