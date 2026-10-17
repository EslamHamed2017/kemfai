import { expect, test, type Page } from '@playwright/test';
import ar from '../../src/locales/ar/common.json';
import en from '../../src/locales/en/common.json';
import { assertNoHorizontalOverflow, openLocalePage, runAxe } from './support/rtl';

test.describe.configure({ mode: 'serial' });

async function authenticate(page: Page, baseURL: string, locale: 'en' | 'ar') {
  const sessionId = `t080-${locale}`;
  await fetch('http://127.0.0.1:4100/__e2e/seed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, token: `t080-${locale}-token`, locale }),
  });
  const url = new URL(baseURL);
  url.protocol = 'https:';
  await page.context().addCookies([
    {
      name: '__Host-kemfai_session',
      value: sessionId,
      url: url.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

for (const locale of ['en', 'ar'] as const) {
  test(`${locale}: four linked live items, RTL and activation gate are accessible`, async ({
    browser,
    baseURL,
  }, testInfo) => {
    test.setTimeout(60_000);
    const messages = locale === 'ar' ? ar : en;
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    await authenticate(page, baseURL!, locale);
    let state = {
      customerAdded: false,
      bankAdded: false,
      productAdded: false,
      firstInvoiceReady: false,
      gatedOnSubscriptionActivation: true,
    };
    await page.route('**/api/onboarding/checklist', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) }),
    );
    await page.goto('/checklist');
    await expect(page.locator('main')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(
      page.getByRole('heading', { name: messages.onboardingChecklist.title }),
    ).toBeVisible();
    await expect(page.getByTestId('checklist-empty')).toBeVisible();
    await expect(page.getByTestId('activation-gate')).toBeVisible();
    await expect(page.locator('.kemfai-checklist-item')).toHaveCount(4);
    const actionLinks = page.locator('.kemfai-checklist-item a');
    await expect(actionLinks).toHaveCount(4);
    await expect(actionLinks.nth(0)).toHaveAttribute('href', '/workspace/modules/module.sales');
    await expect(actionLinks.nth(1)).toHaveAttribute('href', '/workspace/modules/module.accounting');
    await expect(actionLinks.nth(2)).toHaveAttribute('href', '/workspace/modules/module.inventory');
    await expect(actionLinks.nth(3)).toHaveAttribute('href', '/billing');
    const expectedDestinations = [
      /\/workspace\/modules\/module\.sales$/,
      /\/workspace\/modules\/module\.accounting$/,
      /\/workspace\/modules\/module\.inventory$/,
      /\/billing$/,
    ];
    for (let index = 0; index < expectedDestinations.length; index += 1) {
      await actionLinks.nth(index).click();
      await expect(page).toHaveURL(expectedDestinations[index]);
      if (index === 3) {
        await expect(page.getByRole('heading', { name: messages.billing.title })).toBeVisible();
      } else {
        await expect(page.getByText(messages.moduleSelection.workspaceModuleReady, { exact: true })).toBeVisible();
      }
      await page.goto('/checklist');
    }
    await runAxe(page);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`${locale}-empty-desktop.png`),
      fullPage: true,
    });
    state = { ...state, customerAdded: true };
    await page.evaluate(() => window.dispatchEvent(new Event('kemfai:source-record-changed')));
    await expect(page.getByTestId('checklist-customer')).toContainText(
      messages.onboardingChecklist.complete,
    );
    state = {
      customerAdded: true,
      bankAdded: true,
      productAdded: true,
      firstInvoiceReady: true,
      gatedOnSubscriptionActivation: true,
    };
    await page.evaluate(() => window.dispatchEvent(new Event('kemfai:source-record-changed')));
    await expect(page.getByTestId('checklist-firstInvoice')).toContainText(
      messages.onboardingChecklist.complete,
    );
    state = { ...state, gatedOnSubscriptionActivation: false };
    await page.evaluate(() => window.dispatchEvent(new Event('kemfai:source-record-changed')));
    await expect(page.getByTestId('activation-active')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await assertNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`${locale}-active-mobile.png`),
      fullPage: true,
    });
    await context.close();
  });
}

test('loading, error, and feature-off hidden DOM are explicit', async ({ page, baseURL }) => {
  await authenticate(page, baseURL!, 'en');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/onboarding/checklist', async (route) => {
    await gate;
    await route.fulfill({ status: 502, body: '{}' });
  });
  await page.goto('/checklist');
  await expect(page.getByText(en.onboardingChecklist.loading)).toBeVisible();
  release();
  await expect(page.getByText(en.onboardingChecklist.error)).toBeVisible();
  await page.unroute('**/api/onboarding/checklist');
  await page.route('**/api/onboarding/checklist', (route) =>
    route.fulfill({ status: 404, body: '{}' }),
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: en.onboardingChecklist.title })).toHaveCount(0);
});
