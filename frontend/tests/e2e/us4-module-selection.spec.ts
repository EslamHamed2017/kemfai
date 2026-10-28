import { expect, test, type Page } from '@playwright/test';
import ar from '../../src/locales/ar/common.json';
import en from '../../src/locales/en/common.json';
import { assertNoHorizontalOverflow, openLocalePage, runAxe } from './support/rtl';

const options = [
  { key: 'module.accounting', name: 'Accounting', nameAr: 'المحاسبة', includedInCurrentPlan: true, selected: true, requiredPlanTier: null },
  { key: 'module.inventory', name: 'Inventory', nameAr: 'المخزون', includedInCurrentPlan: true, selected: false, requiredPlanTier: null },
  { key: 'module.projects', name: 'Projects', nameAr: 'المشاريع', includedInCurrentPlan: false, selected: false, requiredPlanTier: 'Growth', requiredPlanTierAr: 'النمو' },
];

async function authenticate(page: Page, baseURL: string, sessionId = 't074-private-fixture', token = 'e2e-access-token', locale?: 'en' | 'ar') {
  await fetch('http://127.0.0.1:4100/__e2e/seed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, token, locale }),
  });
  const secureUrl = new URL(baseURL);
  secureUrl.protocol = 'https:';
  await page.context().addCookies([{ name: '__Host-kemfai_session', value: sessionId, url: secureUrl.toString(), httpOnly: true, secure: true, sameSite: 'Lax' }]);
}

for (const locale of ['en', 'ar'] as const) {
  test(`${locale}: selection is localized, accessible, saved, and authoritative on revisit`, async ({ browser, baseURL }, testInfo) => {
    const messages = locale === 'ar' ? ar : en;
    const fixture = options.map((option) => ({ ...option }));
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    await authenticate(page, baseURL!, `t074-${locale}-fixture`, `t074-${locale}-token`, locale);
    await page.route('**/api/modules', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) }));
    await page.route('**/api/modules/selection', async (route) => {
      const keys = route.request().postDataJSON().featureKeys as string[];
      for (const option of fixture) option.selected = keys.includes(option.key);
      await fetch('http://127.0.0.1:4100/__e2e/modules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: `t074-${locale}-token`, featureKeys: keys }) });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ featureKeys: keys }) });
    });

    await page.goto('/modules');
    await expect(page.locator('main')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(page.getByRole('heading', { name: messages.moduleSelection.title })).toBeVisible();
    await expect(page.getByText(messages.moduleSelection.included, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(messages.moduleSelection.upgradeRequired, { exact: true })).toBeVisible();
    await expect(page.getByText(locale === 'ar' ? 'النمو' : 'Growth')).toBeVisible();
    await expect(page.getByLabel(locale === 'ar' ? 'المخزون' : 'Inventory')).toBeEnabled();
    await expect(page.getByLabel(locale === 'ar' ? 'المشاريع' : 'Projects')).toBeDisabled();
    await page.locator(`label[for="select-module.inventory"]`).click();
    await expect(page.getByLabel(locale === 'ar' ? 'المخزون' : 'Inventory')).toBeChecked();
    await page.getByTestId('module-selection-save').click();
    await expect(page.getByTestId('module-selection-success')).toContainText(messages.moduleSelection.saved);
    await expect(page.getByTestId('workspace-module-navigation')).toContainText(locale === 'ar' ? 'المخزون' : 'Inventory');
    await expect(page.getByTestId('workspace-module-checklist')).toContainText(locale === 'ar' ? 'وحدتين' : '2 enabled modules');
    await Promise.all([
      page.waitForURL(/\/workspace\/modules\/module\.inventory$/),
      page.getByTestId('workspace-module-navigation').getByRole('link', { name: locale === 'ar' ? 'المخزون' : 'Inventory' }).click(),
    ]);
    await expect(page.getByRole('heading', { name: locale === 'ar' ? 'المخزون' : 'Inventory' })).toBeVisible();
    await page.goBack();
    await page.reload();
    await expect(page.getByLabel(locale === 'ar' ? 'المخزون' : 'Inventory')).toBeChecked();
    await runAxe(page);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`${locale}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`${locale}-mobile.png`), fullPage: true });
    await context.close();
  });
}

test('denied module explains the required plan and never enters the selection', async ({ page, baseURL }) => {
  await authenticate(page, baseURL!, 't074-denied', 't074-denied-token', 'en');
  await page.route('**/api/modules', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(options) }));
  await page.goto('/modules');
  await expect(page.getByLabel('Projects')).toBeDisabled();
  await expect(page.getByTestId('module-module.projects-upgrade')).toContainText('Growth');
});

test('Arabic keeps the exact returned plan tier identifiable when no Arabic tier label is configured', async ({ page, baseURL }) => {
  await authenticate(page, baseURL!, 't074-ar-plan-fallback', 't074-ar-plan-fallback-token', 'ar');
  await page.route('**/api/modules', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(options.map((option) => option.key === 'module.projects'
      ? { ...option, requiredPlanTierAr: null }
      : option)),
  }));
  await page.goto('/modules');
  await expect(page.getByTestId('module-module.projects-upgrade')).toContainText('Growth');
  await expect(page.getByTestId('module-module.projects-upgrade')).not.toContainText('خطة منشورة أخرى');
});

test('feature flag denial removes all route content', async ({ page, baseURL }) => {
  await authenticate(page, baseURL!, 't074-flagoff', 't074-flagoff-token');
  const response = await page.goto('/modules');
  expect(response?.status()).toBe(404);
  await expect(page.getByText(en.moduleSelection.title)).toHaveCount(0);
  await expect(page.getByTestId('workspace-module-navigation')).toHaveCount(0);
});

test('revoked entitlement removes persisted selection from navigation and workspace route', async ({ page, baseURL }) => {
  await authenticate(page, baseURL!, 't074-revoked', 't074-revoked-token', 'en');
  await fetch('http://127.0.0.1:4100/__e2e/modules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 't074-revoked-token', featureKeys: ['module.inventory'], revoked: true }) });
  await page.goto('/modules');
  await expect(page.getByTestId('workspace-module-navigation').getByRole('link', { name: 'Inventory' })).toHaveCount(0);
  const response = await page.goto('/workspace/modules/module.inventory');
  expect(response?.status()).toBe(404);
});

test('loading, empty, error/retry, and saving states remain explicit', async ({ page, baseURL }) => {
  await authenticate(page, baseURL!, 't074-states', 't074-states-token', 'en');
  let mode: 'error' | 'ready' = 'error';
  let releaseInitialLoad!: () => void;
  const initialLoadGate = new Promise<void>((resolve) => { releaseInitialLoad = resolve; });
  let initialRequest = true;
  await page.route('**/api/modules', async (route) => {
    if (initialRequest) {
      initialRequest = false;
      await initialLoadGate;
    }
    await route.fulfill(
      mode === 'error'
        ? { status: 502, contentType: 'application/json', body: '{}' }
        : { status: 200, contentType: 'application/json', body: JSON.stringify(options) },
    );
  });
  const navigation = page.goto('/modules');
  await expect(page.getByText(en.moduleSelection.loading, { exact: true })).toBeVisible();
  releaseInitialLoad();
  await navigation;
  await expect(page.getByText(en.moduleSelection.loadError, { exact: true })).toBeVisible();
  mode = 'ready';
  await page.getByRole('button', { name: en.moduleSelection.retry }).click();
  await expect(page.getByRole('heading', { name: en.moduleSelection.title })).toBeVisible();

  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route('**/api/modules/selection', async (route) => {
    await saveGate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"featureKeys":["module.accounting"]}' });
  });
  await page.getByTestId('module-selection-save').click();
  await expect(page.getByTestId('module-selection-save')).toHaveText(en.moduleSelection.saving);
  releaseSave();
  await expect(page.getByTestId('module-selection-success')).toContainText(en.moduleSelection.saved);

  await page.unroute('**/api/modules');
  await page.route('**/api/modules', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.reload();
  await expect(page.getByText(en.moduleSelection.empty, { exact: true })).toBeVisible();
});

test('unauthenticated route enters the configured identity-provider flow', async ({ page }) => {
  await page.goto('/modules');
  await expect(page).toHaveURL(/\/protocol\/openid-connect\/auth\?/);
});
