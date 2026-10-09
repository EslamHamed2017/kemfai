import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SetupWizardScreen } from '../../src/app/(onboarding)/setup-wizard/setup-wizard-screen';
import { makeDraft, readDraft } from '../../src/app/(onboarding)/setup-wizard/draft-storage';
import { createLifecycleGuard, type LifecycleGuard } from '../../src/app/(onboarding)/setup-wizard/lifecycle-guard';
import en from '../../src/locales/en/common.json';

/**
 * T056 round-5 (item 3) — wraps the REAL `createLifecycleGuard()` and records every
 * `runIfMounted` call as `{ mountedAtCallTime }`, so a test can assert directly that a
 * post-unmount setter was ATTEMPTED (the call happened) and GATED (it ran while
 * `mountedAtCallTime` was `false`, so the wrapped setter never actually executed) —
 * real instrumentation of the attempt/gate, not an inference from a console warning
 * (modern React does not reliably emit one for a post-unmount `setState`).
 */
function createInstrumentedGuard(): { guard: LifecycleGuard; attempts: boolean[] } {
  const real = createLifecycleGuard();
  const attempts: boolean[] = [];
  const guard: LifecycleGuard = {
    isMounted: () => real.isMounted(),
    setMounted: (value) => real.setMounted(value),
    runIfMounted: (fn) => {
      attempts.push(real.isMounted());
      return real.runIfMounted(fn);
    },
  };
  return { guard, attempts };
}

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

type RouteHandler = (method: string, body: unknown) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

/**
 * jsdom (this suite's test environment) has no global `fetch`/`Response` — unlike the
 * Node-environment BFF specs — so this is a minimal stand-in exposing only the subset
 * of the Response API setup-wizard-screen.tsx actually calls (`ok`, `status`, `json()`).
 */
function installFetch(setupHandler: RouteHandler, completeHandler?: RouteHandler) {
  (global.fetch as unknown) = jest.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const handler = url.includes('/complete') ? completeHandler : setupHandler;
    const result = await handler!(method, body);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
    };
  });
}

const baseState = {
  currentStep: 'country',
  setupComplete: false,
  values: {},
  version: 1,
  stale: false,
  scope: 'scope-alpha',
};

/** A promise this test can resolve on its own schedule, for genuine unmount/transition races. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('SetupWizardScreen (T056 binding-review repairs)', () => {
  it('never leaks a scoped draft across an account/company transition (Alpha -> Beta)', async () => {
    installFetch(() => ({ status: 200, body: { ...baseState, currentStep: 'identity', scope: 'scope-alpha' } }));
    const first = render(<SetupWizardScreen />);
    await waitFor(() => expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(en.setupWizard.fields.legal_name.label), {
      target: { value: 'Alpha Unsaved Secret' },
    });
    await waitFor(() => expect(readDraft()).not.toBeNull());
    first.unmount();

    installFetch(() => ({
      status: 200,
      body: {
        ...baseState,
        currentStep: 'identity',
        scope: 'scope-beta',
        values: { legal_name: 'Beta Fresh Server', trade_name: 'Beta Trade' },
      },
    }));
    render(<SetupWizardScreen />);

    await waitFor(() =>
      expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toHaveValue('Beta Fresh Server'),
    );
    expect(screen.queryByDisplayValue('Alpha Unsaved Secret')).not.toBeInTheDocument();
    // The stale Alpha-scoped draft is quarantined on mismatch; what remains (if anything)
    // is a fresh, empty-dirty envelope re-scoped to Beta — never the leaked Alpha value.
    const remaining = readDraft();
    expect(remaining === null || Object.keys(remaining.dirty).length === 0).toBe(true);
    if (remaining) expect(remaining.scope).toBe('scope-beta');
  });

  it('preserves dirty fields across a same-scope reload (locale switch edge case)', async () => {
    installFetch(() => ({ status: 200, body: { ...baseState, currentStep: 'identity' } }));
    const first = render(<SetupWizardScreen />);
    await waitFor(() => expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(en.setupWizard.fields.legal_name.label), {
      target: { value: 'Draft Name' },
    });
    await waitFor(() => expect(readDraft()).not.toBeNull());
    first.unmount();

    render(<SetupWizardScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toHaveValue('Draft Name'),
    );
  });

  it('clears the draft on session expiry so a later sign-in never restores it', async () => {
    installFetch((method) => {
      if (method === 'PUT') return { status: 401, body: { message: 'Authentication required' } };
      return { status: 200, body: { ...baseState, currentStep: 'country' } };
    });
    render(<SetupWizardScreen />);
    await waitFor(() => expect(screen.getByLabelText(en.setupWizard.fields.country.label)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(en.setupWizard.fields.country.label), { target: { value: 'AE' } });
    await waitFor(() => expect(readDraft()).not.toBeNull());

    fireEvent.click(screen.getByTestId('setup-wizard-next'));
    await waitFor(() => expect(screen.getByTestId('setup-wizard-session-expired')).toBeInTheDocument());
    expect(readDraft()).toBeNull();
  });

  it('shows an explicit conflict notice (never a silent overlay) when the draft baseVersion is stale', async () => {
    const seeded = makeDraft('scope-alpha', 1, 'identity', { legal_name: 'My Edit' });
    window.sessionStorage.setItem('kemfai:setup-wizard:draft:v2', JSON.stringify(seeded));
    installFetch(() => ({
      status: 200,
      body: { ...baseState, currentStep: 'identity', version: 2, values: { legal_name: 'Server Value' } },
    }));
    render(<SetupWizardScreen />);

    await waitFor(() => expect(screen.getByTestId('setup-wizard-conflict')).toBeInTheDocument());
    expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toHaveValue('Server Value');

    fireEvent.click(screen.getByTestId('setup-wizard-conflict-keep-mine'));
    expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toHaveValue('My Edit');
    expect(screen.queryByTestId('setup-wizard-conflict')).not.toBeInTheDocument();
  });

  it('renders a non-empty, localized, retry-preserving alert on a PUT 500 (never a blank alert)', async () => {
    installFetch((method) => {
      if (method === 'PUT') return { status: 500, body: { message: 'boom' } };
      return { status: 200, body: { ...baseState, currentStep: 'country' } };
    });
    render(<SetupWizardScreen />);
    await waitFor(() => expect(screen.getByLabelText(en.setupWizard.fields.country.label)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(en.setupWizard.fields.country.label), { target: { value: 'EG' } });
    fireEvent.click(screen.getByTestId('setup-wizard-next'));

    await waitFor(() => expect(screen.getByTestId('setup-wizard-general-error')).toHaveTextContent(en.setupWizard.errors.general));
    expect(screen.getByTestId('setup-wizard-general-error').textContent).not.toBe('');
    expect(screen.getByLabelText(en.setupWizard.fields.country.label)).toHaveValue('EG');
  });

  it('never completes the wizard on a 2xx whose body says setupComplete: false', async () => {
    const finalValues = {
      country: 'AE',
      legal_name: 'Acme',
      trade_name: 'Acme',
      base_currency: 'AED',
      fiscal_year_start_month: '1',
      fiscal_year_start_day: 1,
      vat_tax_registration: 'TRN-1',
      industry: 7,
      accounting_setup_template: 'standard',
    };
    installFetch(
      (method) => {
        if (method === 'PUT') {
          return { status: 200, body: { ...baseState, currentStep: 'accounting_setup', version: 2, values: finalValues } };
        }
        return { status: 200, body: { ...baseState, currentStep: 'accounting_setup', values: finalValues } };
      },
      () => ({ status: 200, body: { ...baseState, currentStep: 'accounting_setup', setupComplete: false, values: finalValues } }),
    );
    render(<SetupWizardScreen />);

    await waitFor(() =>
      expect(screen.getByLabelText(en.setupWizard.fields.accounting_setup_template.label)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('setup-wizard-next'));

    await waitFor(() => expect(screen.getByTestId('setup-wizard-general-error')).toBeInTheDocument());
    expect(screen.queryByTestId('setup-wizard-complete')).not.toBeInTheDocument();
  });

  it('treats a malformed 2xx GET body (missing scope) as a recoverable error, never a crash', async () => {
    installFetch(() => ({
      status: 200,
      body: { currentStep: 'country', setupComplete: false, values: {}, version: 1, stale: false },
    }));
    render(<SetupWizardScreen />);
    await waitFor(() => expect(screen.getByTestId('setup-wizard-recoverable')).toBeInTheDocument());
  });

  it('rejects a 2xx body with an unrecognized currentStep instead of silently resuming at index zero', async () => {
    installFetch(() => ({
      status: 200,
      body: { ...baseState, currentStep: 'not_a_real_step' },
    }));
    render(<SetupWizardScreen />);
    await waitFor(() => expect(screen.getByTestId('setup-wizard-recoverable')).toBeInTheDocument());
  });

  it('rejects a 2xx body with a negative or non-integer version', async () => {
    installFetch(() => ({ status: 200, body: { ...baseState, version: -1 } }));
    render(<SetupWizardScreen />);
    await waitFor(() => expect(screen.getByTestId('setup-wizard-recoverable')).toBeInTheDocument());
  });

  it('blocks save/navigation controls until an unresolved draft conflict is explicitly resolved, and never wipes the pending conflict draft in the meantime', async () => {
    const seeded = makeDraft('scope-alpha', 1, 'identity', { legal_name: 'My Edit' });
    window.sessionStorage.setItem('kemfai:setup-wizard:draft:v2', JSON.stringify(seeded));
    installFetch(() => ({
      status: 200,
      body: { ...baseState, currentStep: 'identity', version: 2, values: { legal_name: 'Server Value' } },
    }));
    render(<SetupWizardScreen />);

    await waitFor(() => expect(screen.getByTestId('setup-wizard-conflict')).toBeInTheDocument());

    expect(screen.getByTestId('setup-wizard-next')).toBeDisabled();
    expect(screen.getByTestId('setup-wizard-pause')).toBeDisabled();
    expect(screen.getByTestId(`setup-wizard-step-${baseState.currentStep}`)).toBeDisabled();
    // T056 binding-review point 4 — the whole editable fieldset is locked, not just the
    // nav/submit buttons: an edit typed while a conflict is displayed must not be
    // possible to make in the first place.
    expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toBeDisabled();

    // The draft-sync effect must not overwrite the still-unresolved conflicting draft
    // with an empty envelope while the conflict notice is showing.
    const draftWhileUnresolved = readDraft();
    expect(draftWhileUnresolved).not.toBeNull();
    expect(draftWhileUnresolved?.dirty.legal_name).toBe('My Edit');

    // Attempting to submit while unresolved is a no-op: no PUT is sent.
    fireEvent.click(screen.getByTestId('setup-wizard-next'));
    await Promise.resolve();
    expect((global.fetch as jest.Mock).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('setup-wizard-conflict-keep-mine'));
    expect(screen.queryByTestId('setup-wizard-conflict')).not.toBeInTheDocument();
    expect(screen.getByTestId('setup-wizard-next')).not.toBeDisabled();
  });

  it('T056 point 2 — an Alpha PUT left in flight across unmount never wipes the draft Beta writes after mounting fresh (genuine deferred-promise race)', async () => {
    const alphaPut = deferred<{ status: number; body: unknown }>();
    let getCalls = 0;
    (global.fetch as unknown) = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/complete')) throw new Error('complete not used in this test');
      if (method === 'GET') {
        getCalls += 1;
        const body =
          getCalls === 1
            ? { ...baseState, currentStep: 'identity', scope: 'scope-alpha' }
            : { ...baseState, currentStep: 'identity', scope: 'scope-beta', values: { legal_name: 'Beta Server' } };
        return { ok: true, status: 200, json: async () => body };
      }
      const result = await alphaPut.promise;
      return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
    });

    const first = render(<SetupWizardScreen />);
    await waitFor(() => expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(en.setupWizard.fields.legal_name.label), {
      target: { value: 'Alpha Edit' },
    });
    fireEvent.click(screen.getByTestId('setup-wizard-next'));
    // The PUT above is now genuinely pending on alphaPut.promise — not yet resolved.
    first.unmount();

    render(<SetupWizardScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toHaveValue('Beta Server'),
    );
    fireEvent.change(screen.getByLabelText(en.setupWizard.fields.legal_name.label), {
      target: { value: 'Beta Unsaved' },
    });
    await waitFor(() => expect(readDraft()?.scope).toBe('scope-beta'));

    // Now the stale, unmounted Alpha PUT resolves as a 401 — this must never clear the
    // draft Beta's fresh mounted instance already wrote (the shared clearDraft() call on
    // the sessionExpired path must be skipped because the lifecycle generation check
    // recognizes this response as belonging to an unmounted/superseded request).
    await act(async () => {
      alphaPut.resolve({ status: 401, body: { message: 'Authentication required' } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readDraft()?.scope).toBe('scope-beta');
    expect(readDraft()?.dirty.legal_name).toBe('Beta Unsaved');
  });

  it('T056 point 2 — an Alpha PUT resolved with a valid 200 after transitioning away never applies Alpha values/version/scope', async () => {
    const alphaPut = deferred<unknown>();
    let getCalls = 0;
    (global.fetch as unknown) = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/complete')) throw new Error('complete not used in this test');
      if (method === 'GET') {
        getCalls += 1;
        const body =
          getCalls === 1
            ? { ...baseState, currentStep: 'identity', scope: 'scope-alpha' }
            : { ...baseState, currentStep: 'identity', scope: 'scope-beta', values: { legal_name: 'Beta Server' } };
        return { ok: true, status: 200, json: async () => body };
      }
      const result = await alphaPut.promise;
      return { ok: true, status: 200, json: async () => result };
    });

    const first = render(<SetupWizardScreen />);
    await waitFor(() => expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(en.setupWizard.fields.legal_name.label), {
      target: { value: 'Alpha Edit' },
    });
    fireEvent.click(screen.getByTestId('setup-wizard-next'));
    first.unmount();

    render(<SetupWizardScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toHaveValue('Beta Server'),
    );

    // Alpha's PUT finally resolves with a VALID 200 carrying Alpha's own scope/version —
    // it must never reach Beta's screen: a different, unmounted component instance has
    // its own isolated state, and no shared draft/session side effect fires either.
    await act(async () => {
      alphaPut.resolve({
        currentStep: 'currency',
        setupComplete: false,
        values: { legal_name: 'Alpha Leaked' },
        version: 99,
        stale: false,
        scope: 'scope-alpha',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByDisplayValue('Alpha Leaked')).not.toBeInTheDocument();
    expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toHaveValue('Beta Server');
  });

  it('T056 point 1 — a successful PUT response whose scope differs from the initiating scope is rejected before any progression', async () => {
    let getCalls = 0;
    (global.fetch as unknown) = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/complete')) throw new Error('complete not used in this test');
      if (method === 'GET') {
        getCalls += 1;
        return { ok: true, status: 200, json: async () => ({ ...baseState, currentStep: 'identity', scope: 'scope-alpha' }) };
      }
      // A stale-Alpha-scoped browser mutating what the server now resolves as Beta.
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...baseState, currentStep: 'currency', scope: 'scope-beta' }),
      };
    });

    render(<SetupWizardScreen />);
    await waitFor(() => expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toBeInTheDocument());
    expect(getCalls).toBe(1);

    fireEvent.change(screen.getByLabelText(en.setupWizard.fields.legal_name.label), { target: { value: 'Edit' } });
    fireEvent.click(screen.getByTestId('setup-wizard-next'));

    // The mismatch quarantines the draft and reloads authoritative state instead of
    // trusting the response's `currentStep: 'currency'`.
    await waitFor(() => expect(getCalls).toBe(2));
    await waitFor(() => expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toBeInTheDocument());
    expect(screen.queryByLabelText(en.setupWizard.fields.base_currency.label)).not.toBeInTheDocument();
  });

  it('T056 point 1 — a successful completion response whose scope differs from the initiating scope never shows the complete screen', async () => {
    const finalValues = {
      country: 'AE',
      legal_name: 'Acme',
      trade_name: 'Acme',
      base_currency: 'AED',
      fiscal_year_start_month: '1',
      fiscal_year_start_day: 1,
      vat_tax_registration: 'TRN-1',
      industry: 7,
      accounting_setup_template: 'standard',
    };
    let getCalls = 0;
    (global.fetch as unknown) = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/complete')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...baseState,
            currentStep: 'accounting_setup',
            setupComplete: true,
            values: finalValues,
            scope: 'scope-beta',
          }),
        };
      }
      if (method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...baseState, currentStep: 'accounting_setup', values: finalValues, scope: 'scope-alpha' }),
        };
      }
      getCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...baseState, currentStep: 'accounting_setup', values: finalValues, scope: 'scope-alpha' }),
      };
    });

    render(<SetupWizardScreen />);
    await waitFor(() =>
      expect(screen.getByLabelText(en.setupWizard.fields.accounting_setup_template.label)).toBeInTheDocument(),
    );
    const initialGetCalls = getCalls;
    fireEvent.click(screen.getByTestId('setup-wizard-next'));

    await waitFor(() => expect(getCalls).toBeGreaterThan(initialGetCalls));
    expect(screen.queryByTestId('setup-wizard-complete')).not.toBeInTheDocument();
  });

  // T056 round-3 point 3 — handleNext/handlePause/handleFinish each have their own
  // `finally` block that must not mutate `saving`/`completing` component state on
  // behalf of a request this component is no longer mounted to observe. Each test below
  // triggers the handler, unmounts while its request is genuinely still pending (a
  // deferred promise, not a timer), then resolves it post-unmount — the guarded
  // `finally` must not throw/warn, and the in-flight request's OWN response-application
  // generation check must still have prevented any state from applying.
  it('T056 point 3 — handleNext (save+advance): resolving its PUT after unmount is attempted but GATED (never applied)', async () => {
    const { guard, attempts } = createInstrumentedGuard();
    const pendingPut = deferred<{ status: number; body: unknown }>();
    (global.fetch as unknown) = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ ...baseState, currentStep: 'identity', scope: 'scope-alpha' }) };
      }
      const result = await pendingPut.promise;
      return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
    });

    const screenInstance = render(<SetupWizardScreen createGuard={() => guard} />);
    await waitFor(() => expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('setup-wizard-next'));
    screenInstance.unmount();
    expect(guard.isMounted()).toBe(false);

    await act(async () => {
      pendingPut.resolve({ status: 200, body: { ...baseState, currentStep: 'currency', scope: 'scope-alpha' } });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The `finally` block's guarded `setSaving(false)` call was ATTEMPTED (runIfMounted
    // was invoked at least once) but every attempt happened while `mountedAtCallTime` was
    // false — real proof the setter was gated, not merely "no console warning fired".
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((mountedAtCallTime) => mountedAtCallTime === false)).toBe(true);
  });

  it('T056 point 3 — handlePause: resolving its PUT after unmount is attempted but GATED (never applied)', async () => {
    const { guard, attempts } = createInstrumentedGuard();
    const pendingPut = deferred<{ status: number; body: unknown }>();
    (global.fetch as unknown) = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ ...baseState, currentStep: 'identity', scope: 'scope-alpha' }) };
      }
      const result = await pendingPut.promise;
      return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
    });

    const screenInstance = render(<SetupWizardScreen createGuard={() => guard} />);
    await waitFor(() => expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('setup-wizard-pause'));
    screenInstance.unmount();
    expect(guard.isMounted()).toBe(false);

    await act(async () => {
      pendingPut.resolve({ status: 200, body: { ...baseState, currentStep: 'identity', scope: 'scope-alpha' } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((mountedAtCallTime) => mountedAtCallTime === false)).toBe(true);
  });

  it('T056 point 3 — handleFinish (completion): resolving its POST after unmount is attempted but GATED (never applied)', async () => {
    const { guard, attempts } = createInstrumentedGuard();
    const finalValues = {
      country: 'AE',
      legal_name: 'Acme',
      trade_name: 'Acme',
      base_currency: 'AED',
      fiscal_year_start_month: '1',
      fiscal_year_start_day: 1,
      vat_tax_registration: 'TRN-1',
      industry: 7,
      accounting_setup_template: 'standard',
    };
    const pendingComplete = deferred<{ status: number; body: unknown }>();
    (global.fetch as unknown) = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/complete')) {
        const result = await pendingComplete.promise;
        return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
      }
      if (method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...baseState, currentStep: 'accounting_setup', values: finalValues, scope: 'scope-alpha' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...baseState, currentStep: 'accounting_setup', values: finalValues, scope: 'scope-alpha' }),
      };
    });

    const screenInstance = render(<SetupWizardScreen createGuard={() => guard} />);
    await waitFor(() =>
      expect(screen.getByLabelText(en.setupWizard.fields.accounting_setup_template.label)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('setup-wizard-next'));
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.some(([url]) => String(url).includes('/complete'))).toBe(true));
    screenInstance.unmount();
    expect(guard.isMounted()).toBe(false);

    await act(async () => {
      pendingComplete.resolve({
        status: 200,
        body: { ...baseState, currentStep: 'accounting_setup', setupComplete: true, values: finalValues, scope: 'scope-alpha' },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((mountedAtCallTime) => mountedAtCallTime === false)).toBe(true);
  });

  // T056 round-5 (item 3) — proves the Strict-Mode fix directly: React's development
  // mount -> cleanup -> remount replay must leave the component's lifecycle guard mounted
  // (`true`) once the second setup has run, so a handler that resolves AFTER that replay
  // still applies its state update. Before this round's fix, `mountedRef` was set to
  // `false` by the first (replay) cleanup and NEVER re-armed on the second setup, so this
  // assertion would have failed (the value would stay stuck at its initial state).
  it('T056 round-5 point 3 — React Strict Mode double-invoke replay still applies a mounted handler\'s state update', async () => {
    installFetch((method) => {
      if (method === 'PUT') {
        return { status: 200, body: { ...baseState, currentStep: 'currency', scope: 'scope-alpha' } };
      }
      return { status: 200, body: { ...baseState, currentStep: 'identity' } };
    });

    render(
      <StrictMode>
        <SetupWizardScreen />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByLabelText(en.setupWizard.fields.legal_name.label)).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('setup-wizard-next'));

    // If the lifecycle guard were stuck at `false` after Strict Mode's replay (the exact
    // pre-fix defect), this PUT's successful response would never advance the active step
    // — the screen would stay on the identity fields forever.
    await waitFor(() =>
      expect(screen.getByLabelText(en.setupWizard.fields.base_currency.label)).toBeInTheDocument(),
    );
  });
});
