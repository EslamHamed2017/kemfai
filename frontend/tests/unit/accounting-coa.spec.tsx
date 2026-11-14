import type { ComponentType } from 'react';
import axe from 'axe-core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

let activeLocale: 'en' | 'ar' = 'en';

jest.mock('next-intl', () => ({
  useLocale: () => activeLocale,
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

type ScreenModule = {
  ChartOfAccountsScreen: ComponentType;
};
type DraftModule = {
  DraftComposer: ComponentType;
};

function chartScreen(): ComponentType {
  const path =
    '../../src/app/(workspace)/accounting/chart-of-accounts/' + 'chart-of-accounts-screen';
  return jest.requireActual<ScreenModule>(path).ChartOfAccountsScreen;
}

function draftComposer(): ComponentType {
  const path = '../../src/app/(workspace)/accounting/drafts/' + 'draft-composer';
  return jest.requireActual<DraftModule>(path).DraftComposer;
}

function response(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  };
}

const parent = {
  id: '29292929-1111-4111-8111-111111111111',
  code: '1000',
  name: { en: 'Assets', ar: 'الأصول' },
  accountType: 'asset_current',
  nodeKind: 'parent',
  parentId: null,
  active: true,
  version: 1,
};
const posting = {
  id: '29292929-2222-4222-8222-222222222222',
  code: '1010',
  name: { en: 'Cash', ar: 'النقدية' },
  accountType: 'asset_cash',
  nodeKind: 'posting',
  parentId: parent.id,
  active: true,
  version: 1,
};

beforeEach(() => {
  activeLocale = 'en';
  jest.restoreAllMocks();
});

afterEach(() => {
  document.documentElement.style.fontSize = '';
});

describe('Accounting chart/draft UI (T029)', () => {
  it('shows an announced loading state and disables mutation controls until data arrives', () => {
    global.fetch = jest.fn(() => new Promise(() => undefined)) as unknown as typeof fetch;
    const Chart = chartScreen();
    render(<Chart />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('account-create')).toBeDisabled();
  });

  it('renders a localized empty state without manufacturing a root account', async () => {
    global.fetch = jest.fn(async () =>
      response(200, { items: [], nextCursor: null }),
    ) as unknown as typeof fetch;
    const Chart = chartScreen();
    render(<Chart />);
    expect(await screen.findByTestId('accounting-coa-empty')).toBeInTheDocument();
    expect(screen.queryByRole('treeitem')).not.toBeInTheDocument();
  });

  it('announces a recoverable error and retries the exact GET', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response(503, { message: 'unavailable' }))
      .mockResolvedValueOnce(response(200, { items: [], nextCursor: null }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const Chart = chartScreen();
    render(<Chart />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toBe('');
    fireEvent.click(screen.getByTestId('accounting-coa-retry'));
    await screen.findByTestId('accounting-coa-empty');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders English hierarchy with semantic tree levels and posting leaves', async () => {
    global.fetch = jest.fn(async () =>
      response(200, { items: [parent, posting], nextCursor: null }),
    ) as unknown as typeof fetch;
    const Chart = chartScreen();
    render(<Chart />);
    const tree = await screen.findByRole('tree', { name: /chart|account/i });
    expect(tree).toHaveAttribute('dir', 'ltr');
    expect(screen.getByRole('treeitem', { name: /1000.*Assets/i })).toHaveAttribute(
      'aria-level',
      '1',
    );
    expect(screen.getByRole('treeitem', { name: /1010.*Cash/i })).toHaveAttribute(
      'aria-level',
      '2',
    );
  });

  it('renders Arabic labels and reverses direction without changing identifiers', async () => {
    activeLocale = 'ar';
    global.fetch = jest.fn(async () =>
      response(200, { items: [parent, posting], nextCursor: null }),
    ) as unknown as typeof fetch;
    const Chart = chartScreen();
    render(<Chart />);
    const tree = await screen.findByRole('tree');
    expect(tree).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('treeitem', { name: /1000.*الأصول/ })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /1010.*النقدية/ })).toBeInTheDocument();
  });

  it('supports tree keyboard expansion and focus movement', async () => {
    global.fetch = jest.fn(async () =>
      response(200, { items: [parent, posting], nextCursor: null }),
    ) as unknown as typeof fetch;
    const Chart = chartScreen();
    render(<Chart />);
    const root = await screen.findByRole('treeitem', { name: /1000/ });
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(root).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    expect(screen.getByRole('treeitem', { name: /1010/ })).toHaveFocus();
  });

  it('rejects a parent account visibly before any draft-line POST', async () => {
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('parent must never be submitted');
      return response(200, { items: [parent, posting], nextCursor: null });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const Draft = draftComposer();
    render(<Draft />);
    const account = await screen.findByTestId('draft-account');
    fireEvent.change(account, { target: { value: parent.id } });
    fireEvent.click(screen.getByTestId('draft-line-add'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/posting|parent/i);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('loads later account pages so a parent remains deliberately selectable for rejection', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response(200, { items: [posting], nextCursor: posting.id }))
      .mockResolvedValueOnce(response(200, { items: [parent], nextCursor: null }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const Draft = draftComposer();
    render(<Draft />);

    const account = await screen.findByTestId('draft-account');
    await waitFor(() => expect(account).toHaveValue(''));
    fireEvent.change(account, { target: { value: parent.id } });
    expect(account).toHaveValue(parent.id);
    fireEvent.click(screen.getByTestId('draft-line-add'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/posting|parent/i);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/accounting/v1/accounts?active=true&cursor=${encodeURIComponent(posting.id)}`,
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('saves and validates a posting-account line as a zero-ledger draft with no posting control', async () => {
    const draftId = '29292929-4444-4444-8444-444444444444';
    const journalId = '29292929-6666-4666-8666-666666666666';
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/validate')) {
        return response(200, {
          result: { draftId, draftVersion: 1, status: 'valid_for_draft', ledgerEffect: 'none' },
          ledgerEffect: 'none',
        }, { etag: '"1"' });
      }
      if (init?.method === 'POST') {
        return response(201, {
          resource: { id: draftId, version: 1, status: 'draft', ledgerEffect: 'none' },
          ledgerEffect: 'none',
        }, { etag: '"1"' });
      }
      if (url.includes('/journals')) return response(200, { items: [{
        id: journalId, code: 'GEN', name: { en: 'General journal', ar: 'دفتر اليومية العام' },
        journalType: 'general', active: true, selectableForDrafts: true, version: 1,
      }], nextCursor: null });
      if (url.includes('/currencies')) return response(200, { items: [{
        id: '29292929-7777-4777-8777-777777777777', currencyCode: 'AED', enabled: true,
        isBase: true, nativeDecimalPlaces: 2, nativeMetadataVersion: 'aed-v1', version: 1,
      }], nextCursor: null });
      if (url.includes('/dimension-')) return response(200, { items: [], nextCursor: null });
      return response(200, { items: [posting], nextCursor: null });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const Draft = draftComposer();
    render(<Draft />);

    fireEvent.change(await screen.findByTestId('draft-account'), { target: { value: posting.id } });
    fireEvent.click(screen.getByTestId('draft-line-add'));
        fireEvent.change(screen.getByTestId('draft-accounting-date'), { target: { value: '2026-11-03' } });
    fireEvent.change(screen.getByTestId('draft-line-0-transaction-debit'), { target: { value: '100.0000' } });
    fireEvent.change(screen.getByTestId('draft-line-0-transaction-credit'), { target: { value: '0.0000' } });
    fireEvent.change(screen.getByTestId('draft-line-0-base-debit'), { target: { value: '100.0000' } });
    fireEvent.change(screen.getByTestId('draft-line-0-base-credit'), { target: { value: '0.0000' } });
    fireEvent.click(screen.getByTestId('draft-save'));

    expect(await screen.findByTestId('draft-saved')).toHaveTextContent(/none/i);
    const save = fetchMock.mock.calls.find(([url, init]) =>
      url === '/api/accounting/v1/drafts' && init?.method === 'POST');
    expect(JSON.parse(String(save?.[1]?.body))).toEqual(expect.objectContaining({
      journalId,
      accountingDate: '2026-11-03',
      lines: [expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        accountId: posting.id,
        transactionDebit: '100.0000',
        transactionCredit: '0.0000',
        baseDebit: '100.0000',
        baseCredit: '0.0000',
      })],
    }));

    fireEvent.click(screen.getByTestId('draft-validate'));
    expect(await screen.findByTestId('draft-validation')).toHaveTextContent(/valid_for_draft.*none/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const validate = fetchMock.mock.calls.find(([url]) => url.endsWith('/validate'));
    expect(validate?.[0]).toBe(`/api/accounting/v1/drafts/${draftId}/validate`);
    expect(new Headers(validate?.[1]?.headers).get('if-match')).toBe('"1"');
    expect(screen.queryByRole('button', { name: /^.*post.*$/i })).not.toBeInTheDocument();
  });

  it('preserves edits and restores focus when a 412 version conflict is announced', async () => {
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return response(412, { message: 'stale version' });
      return response(200, { items: [parent, posting], nextCursor: null });
    }) as unknown as typeof fetch;
    const Chart = chartScreen();
    render(<Chart />);
    fireEvent.click(await screen.findByTestId(`account-edit-${posting.id}`));
    const name = screen.getByLabelText(/name.*en|english name/i);
    fireEvent.change(name, { target: { value: 'Unsaved cash edit' } });
    fireEvent.click(screen.getByTestId('account-save'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/conflict|changed|stale/i);
    expect(name).toHaveValue('Unsaved cash edit');
    expect(name).toHaveFocus();
  });

  it('creates an account through the authenticated BFF collection and renders its returned resource', async () => {
    const created = {
      ...posting,
      id: '29292929-3333-4333-8333-333333333333',
      code: '1020',
      name: { en: 'Bank', ar: 'البنك' },
    };
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response(201, { resource: created });
      return response(200, { items: [parent], nextCursor: null });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const Chart = chartScreen();
    render(<Chart />);
    await screen.findByRole('treeitem', { name: /1000.*Assets/i });
    fireEvent.click(screen.getByTestId('account-create'));
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: '1020' } });
    fireEvent.change(screen.getByLabelText(/name.*en|english name/i), {
      target: { value: 'Bank' },
    });
    fireEvent.change(screen.getByLabelText(/name.*ar|arabic name/i), {
      target: { value: 'البنك' },
    });
    fireEvent.change(screen.getByLabelText(/account.*type/i), {
      target: { value: 'asset_cash' },
    });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: parent.id } });
    fireEvent.click(screen.getByTestId('account-save'));

    const createdItem = await screen.findByRole('treeitem', { name: /1020.*Bank/i });
    expect(createdItem).toBeInTheDocument();
    await waitFor(() => expect(createdItem).toHaveFocus());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/accounting/v1/accounts');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual(
      expect.objectContaining({
        code: '1020',
        name: { en: 'Bank', ar: 'البنك' },
        parentId: parent.id,
      }),
    );
    expect(new Headers(post?.[1]?.headers).get('idempotency-key')).toBeTruthy();
  });

  it('retries an ambiguous edit with the same idempotency key and loaded version', async () => {
    let patches = 0;
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patches += 1;
        return patches === 1
          ? response(503, { message: 'audit unavailable' })
          : response(200, { resource: { ...posting, version: 2 } });
      }
      return response(200, { items: [parent, posting], nextCursor: null });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const Chart = chartScreen();
    render(<Chart />);
    fireEvent.click(await screen.findByTestId(`account-edit-${posting.id}`));
    fireEvent.click(screen.getByTestId('account-save'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/general/i);
    fireEvent.click(screen.getByTestId('account-save'));
    await screen.findByRole('status');

    const patchCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(patchCalls).toHaveLength(2);
    expect(new Headers(patchCalls[0][1]?.headers).get('idempotency-key')).toBe(
      new Headers(patchCalls[1][1]?.headers).get('idempotency-key'),
    );
    expect(new Headers(patchCalls[1][1]?.headers).get('if-match')).toBe('"1"');
  });

  it('deactivates with the loaded strong version and removes the account from active hierarchy', async () => {
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return response(200, { resource: { ...posting, active: false, version: 2 } });
      }
      return response(200, { items: [parent, posting], nextCursor: null });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const Chart = chartScreen();
    render(<Chart />);
    await screen.findByRole('treeitem', { name: /1010.*Cash/i });
    fireEvent.click(screen.getAllByRole('button', { name: /deactivate/i })[1]);

    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: /1010.*Cash/i })).not.toBeInTheDocument(),
    );
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patch?.[0]).toContain(posting.id);
    expect(new Headers(patch?.[1]?.headers).get('if-match')).toBe('"1"');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ active: false });
  });

  it('moves focus into the account editor and restores it to the invoking control on cancel', async () => {
    global.fetch = jest.fn(async () =>
      response(200, { items: [parent, posting], nextCursor: null }),
    ) as unknown as typeof fetch;
    const Chart = chartScreen();
    render(<Chart />);
    await screen.findByRole('tree');
    const create = screen.getByTestId('account-create');
    create.focus();
    fireEvent.click(create);
    expect(screen.getByLabelText(/code/i)).toHaveFocus();
    fireEvent.click(screen.getByTestId('account-editor-cancel'));
    expect(create).toHaveFocus();
  });

  it.each(['en', 'ar'] as const)(
    'focuses and describes the invalid draft account selection in %s',
    async (locale) => {
      activeLocale = locale;
      global.fetch = jest.fn(async () =>
        response(200, { items: [parent, posting], nextCursor: null }),
      ) as unknown as typeof fetch;
      const Draft = draftComposer();
      render(<Draft />);
      const account = await screen.findByTestId('draft-account');
      fireEvent.change(account, { target: { value: parent.id } });
      const add = screen.getByTestId('draft-line-add');
      add.focus();
      fireEvent.click(add);
      const alert = await screen.findByRole('alert');
      expect(account).toHaveFocus();
      expect(account).toHaveAttribute('aria-invalid', 'true');
      expect(account).toHaveAttribute('aria-describedby', alert.id);
      expect(alert).toHaveAttribute('aria-live', 'assertive');
    },
  );

  it('has no axe violations in the populated EN hierarchy', async () => {
    global.fetch = jest.fn(async () =>
      response(200, { items: [parent, posting], nextCursor: null }),
    ) as unknown as typeof fetch;
    const Chart = chartScreen();
    const { container } = render(<Chart />);
    await screen.findByRole('tree');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('remains operable at a 200% root font size without fixed-width clipping contracts', async () => {
    document.documentElement.style.fontSize = '32px';
    global.fetch = jest.fn(async () =>
      response(200, { items: [parent, posting], nextCursor: null }),
    ) as unknown as typeof fetch;
    const Chart = chartScreen();
    render(<Chart />);
    const surface = await screen.findByTestId('accounting-coa');
    expect(surface.getAttribute('style') ?? '').not.toMatch(/width:\s*\d+px/i);
    expect(screen.getByTestId('account-create')).toBeVisible();
    expect(screen.getByRole('tree')).toBeVisible();
  });
});
