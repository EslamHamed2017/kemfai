import type { ComponentType } from 'react';
import axe from 'axe-core';
import { fireEvent, render, screen, within } from '@testing-library/react';

let activeLocale: 'en' | 'ar' = 'en';
jest.mock('next-intl', () => ({
  useLocale: () => activeLocale,
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

type DimensionsModule = { DimensionsScreen: ComponentType<{ companyId?: string }> };
type DraftModule = { DraftComposer: ComponentType<{ companyId?: string }> };
function dimensionsScreen() {
  const path = '../../src/app/(workspace)/accounting/dimensions/' + 'dimensions-screen';
  return jest.requireActual<DimensionsModule>(path).DimensionsScreen;
}
function draftComposer() {
  const path = '../../src/app/(workspace)/accounting/drafts/' + 'draft-composer';
  return jest.requireActual<DraftModule>(path).DraftComposer;
}
function response(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}
const projectDefinition = {
  id: '72727272-1111-4111-8111-111111111111', key: 'project', kind: 'built_in',
  name: { en: 'Project', ar: 'المشروع' }, active: true, version: 3,
};
const costCenterDefinition = {
  id: '72727272-2222-4222-8222-222222222222', key: 'cost_center', kind: 'built_in',
  name: { en: 'Cost Center', ar: 'مركز التكلفة' }, active: true, version: 2,
};
const projectValue = {
  id: '73737373-1111-4111-8111-111111111111', definitionId: projectDefinition.id,
  code: 'PRJ-100', name: { en: 'Migration', ar: 'الترحيل' }, active: true, version: 4,
};
const inactiveProjectValue = {
  id: '73737373-2222-4222-8222-222222222222', definitionId: projectDefinition.id,
  code: 'PRJ-OLD', name: { en: 'Legacy rollout', ar: 'الإطلاق السابق' }, active: false, version: 7,
};
const costCenterValue = {
  id: '73737373-3333-4333-8333-333333333333', definitionId: costCenterDefinition.id,
  code: 'CC-20', name: { en: 'Operations', ar: 'العمليات' }, active: true, version: 1,
};
const postingAccount = {
  id: '74747474-1111-4111-8111-111111111111', code: '6100',
  name: { en: 'Professional fees', ar: 'أتعاب مهنية' }, accountType: 'expense',
  nodeKind: 'posting', parentId: null, active: true, version: 1,
};
const projectRule = {
  id: '75757575-1111-4111-8111-111111111111', accountId: postingAccount.id,
  transactionType: null, dimensionDefinitionId: projectDefinition.id,
  requirement: 'required', effectiveFrom: null, effectiveTo: null, active: true, version: 5,
};
const page = (items: unknown[]) => ({ items, nextCursor: null });
function successfulFetch(url: string, init?: RequestInit) {
  if (init?.method && init.method !== 'GET')
    return Promise.resolve(response(200, { resource: projectRule }, { etag: '"5"' }));
  if (url.includes('dimension-definitions'))
    return Promise.resolve(response(200, page([projectDefinition, costCenterDefinition])));
  if (url.includes('dimension-values'))
    return Promise.resolve(response(200, page([projectValue, inactiveProjectValue, costCenterValue])));
  if (url.includes('dimension-rules')) return Promise.resolve(response(200, page([projectRule])));
  if (url.includes('accounts')) return Promise.resolve(response(200, page([postingAccount])));
  return Promise.resolve(response(404, {}));
}

beforeEach(() => { activeLocale = 'en'; jest.restoreAllMocks(); });
afterEach(() => { document.documentElement.style.fontSize = ''; });

describe('Accounting dimensions and draft UI (T077)', () => {
  it('announces loading and disables dimension mutations', () => {
    global.fetch = jest.fn(() => new Promise(() => undefined)) as unknown as typeof fetch;
    const Dimensions = dimensionsScreen();
    render(<Dimensions companyId="company-a1" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('dimension-value-create')).toBeDisabled();
    expect(screen.getByTestId('dimension-rule-create')).toBeDisabled();
  });

  it('shows a localized empty state without inventing values or rules', async () => {
    global.fetch = jest.fn(async () => response(200, page([]))) as unknown as typeof fetch;
    const Dimensions = dimensionsScreen();
    render(<Dimensions />);
    expect(await screen.findByTestId('accounting-dimensions-empty')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /PRJ-|CC-/i })).not.toBeInTheDocument();
  });

  it('announces an error and retries the failed collection request', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(response(503, {})).mockImplementation(successfulFetch);
    global.fetch = fetchMock as unknown as typeof fetch;
    const Dimensions = dimensionsScreen();
    render(<Dimensions />);
    expect(await screen.findByRole('alert')).toHaveAttribute('aria-live', 'assertive');
    fireEvent.click(screen.getByTestId('accounting-dimensions-retry'));
    await screen.findByRole('table', { name: /dimension/i });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('supports progressive disclosure and keyboard rule configuration', async () => {
    global.fetch = jest.fn(successfulFetch) as unknown as typeof fetch;
    const Dimensions = dimensionsScreen();
    render(<Dimensions />);
    const project = await screen.findByRole('button', { name: /project/i });
    project.focus();
    fireEvent.keyDown(project, { key: 'Enter' });
    expect(screen.getByRole('region', { name: /project/i })).toBeVisible();
    fireEvent.click(screen.getByTestId('dimension-rule-create'));
    const editor = screen.getByRole('dialog', { name: /rule/i });
    const account = within(editor).getByLabelText(/account/i);
    expect(account).toHaveFocus();
    fireEvent.change(account, { target: { value: postingAccount.id } });
    const requirement = within(editor).getByLabelText(/requirement/i);
    fireEvent.keyDown(requirement, { key: 'ArrowDown' });
    fireEvent.change(requirement, { target: { value: 'required' } });
    expect(requirement).toHaveValue('required');
  });

  it.each(['en', 'ar'] as const)('renders labels, direction, and unchanged IDs in %s', async (locale) => {
    activeLocale = locale;
    global.fetch = jest.fn(successfulFetch) as unknown as typeof fetch;
    const Dimensions = dimensionsScreen();
    render(<Dimensions />);
    const surface = await screen.findByTestId('accounting-dimensions');
    expect(surface).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    expect(screen.getByText(locale === 'ar' ? 'المشروع' : 'Project')).toBeInTheDocument();
    expect(screen.getByText(locale === 'ar' ? 'الترحيل' : 'Migration'))
      .toHaveAttribute('data-resource-id', projectValue.id);
  });

  it('keeps inactive history visible but unavailable for a new draft', async () => {
    global.fetch = jest.fn(successfulFetch) as unknown as typeof fetch;
    const Draft = draftComposer();
    render(<Draft />);
    fireEvent.change(await screen.findByTestId('draft-account'), { target: { value: postingAccount.id } });
    fireEvent.click(screen.getByTestId('draft-line-add'));
    const selector = await screen.findByTestId(`draft-dimension-${projectDefinition.id}`);
    const inactive = within(selector).getByRole('option', { name: /PRJ-OLD.*Legacy rollout/i });
    expect(inactive).toBeDisabled();
    expect(inactive).toHaveAttribute('data-historical', 'true');
  });

  it('announces all missing Project and Cost Center errors and focuses the first selector', async () => {
    const validation = {
      result: {
        draftId: '76767676-1111-4111-8111-111111111111', draftVersion: 2, status: 'invalid',
        errors: [projectDefinition, costCenterDefinition].map((definition) => ({
          code: 'DIMENSION_REQUIRED', messageKey: 'accountingDraft.errors.dimensionRequired',
          lineId: '77777777-1111-4111-8111-111111111111', resourceId: definition.id, field: 'dimensions',
        })),
        configurationSnapshot: { dimensionRules: { [projectRule.id]: projectRule.version } },
        ledgerEffect: 'none',
      }, ledgerEffect: 'none',
    };
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/validate')) return response(200, validation, { etag: '"2"' });
      if (url.includes('drafts') && init?.method === 'POST')
        return response(201, { resource: { id: validation.result.draftId, version: 1,
          status: 'draft', ledgerEffect: 'none' } }, { etag: '"1"' });
      return successfulFetch(url, init);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const Draft = draftComposer();
    render(<Draft />);
    fireEvent.change(await screen.findByTestId('draft-account'), { target: { value: postingAccount.id } });
    fireEvent.click(screen.getByTestId('draft-line-add'));
    fireEvent.submit(screen.getByTestId('draft-save').closest('form')!);
    fireEvent.click(await screen.findByTestId('draft-validate'));
    const issues = await screen.findByRole('alert', { name: /dimension/i });
    expect(issues).toHaveTextContent(/Project/);
    expect(issues).toHaveTextContent(/Cost Center/);
    expect(issues).toHaveAttribute('aria-live', 'assertive');
    const project = screen.getByTestId(`draft-dimension-${projectDefinition.id}`);
    expect(project).toHaveAttribute('aria-invalid', 'true');
    expect(project).toHaveFocus();
    expect(screen.getByTestId('draft-validation')).toHaveTextContent(/invalid.*none/i);
  });

  it('has no axe violations on the populated English surface', async () => {
    global.fetch = jest.fn(successfulFetch) as unknown as typeof fetch;
    const Dimensions = dimensionsScreen();
    const { container } = render(<Dimensions />);
    await screen.findByRole('table', { name: /dimension/i });
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('remains keyboard-operable at 200% zoom without fixed-width clipping', async () => {
    document.documentElement.style.fontSize = '32px';
    global.fetch = jest.fn(successfulFetch) as unknown as typeof fetch;
    const Dimensions = dimensionsScreen();
    render(<Dimensions />);
    const surface = await screen.findByTestId('accounting-dimensions');
    expect(surface.getAttribute('style') ?? '').not.toMatch(/width:\s*\d+px/i);
    const create = screen.getByTestId('dimension-value-create');
    create.focus();
    fireEvent.keyDown(create, { key: 'Enter' });
    expect(await screen.findByRole('dialog')).toBeVisible();
  });
});
