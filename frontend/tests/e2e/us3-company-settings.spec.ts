import { expect, test, type Page } from '@playwright/test';
import ar from '../../src/locales/ar/common.json';
import en from '../../src/locales/en/common.json';
import {
  assertMirrored,
  assertNoHorizontalOverflow,
  openLocalePage,
  runAxe,
  VIEWPORT,
} from './support/rtl';

const settings = {
  country: 'AE',
  legal_name: 'Acme LLC',
  trade_name: 'Acme',
  base_currency: 'AED',
  fiscal_year_start_month: 1,
  fiscal_year_start_day: 1,
  vat_tax_registration: '100000000000003',
  industry: 7,
  accounting_setup_template: 'standard',
};

async function authenticate(page: Page, baseURL: string) {
  const secureUrl = new URL(baseURL);
  secureUrl.protocol = 'https:';
  await page.context().addCookies([
    {
      name: '__Host-kemfai_session',
      value: 't107-private-fixture',
      url: secureUrl.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

for (const locale of ['en', 'ar'] as const) {
  test(`${locale}: direct company settings route is keyboard-operable and localized`, async ({
    browser,
    baseURL,
  }) => {
    const messages = locale === 'ar' ? ar : en;
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      await authenticate(page, baseURL!);
      let saved: unknown;
      let wizardCalls = 0;
      await page.route('**/api/companies/current/setup**', async (route) => {
        wizardCalls += 1;
        await route.abort();
      });
      await page.route('**/api/companies/current/settings', async (route) => {
        if (route.request().method() === 'PUT') {
          saved = route.request().postDataJSON();
          await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ values: settings, setupComplete: true }),
        });
      });

      await page.goto('/company-settings');
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(
        page.getByRole('heading', { name: messages.companySettings.title }),
      ).toBeVisible();
      await page.getByLabel(messages.setupWizard.fields.legal_name.label).fill('Acme Holdings LLC');
      await page.getByTestId('company-settings-save').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('company-settings-saved')).toContainText(
        messages.companySettings.saved,
      );
      expect(saved).toEqual({
        values: { legal_name: 'Acme Holdings LLC' },
      });
      expect(wizardCalls).toBe(0);
      await runAxe(page);
      await assertNoHorizontalOverflow(page);
    } finally {
      await context.close();
    }
  });
}

test('save action mirrors between English and Arabic', async ({ browser, baseURL }) => {
  const english = await openLocalePage(browser, baseURL!, 'en');
  const arabic = await openLocalePage(browser, baseURL!, 'ar');
  try {
    for (const { page } of [english, arabic]) {
      await authenticate(page, baseURL!);
      await page.route('**/api/companies/current/settings', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ values: settings, setupComplete: true }),
        }),
      );
      await page.goto('/company-settings');
    }
    await assertMirrored(
      english.page.getByTestId('company-settings-save'),
      arabic.page.getByTestId('company-settings-save'),
      VIEWPORT.width,
    );
  } finally {
    await english.context.close();
    await arabic.context.close();
  }
});
