import { test, expect, type Page } from '@playwright/test';
import en from '../../src/locales/en/common.json';
import ar from '../../src/locales/ar/common.json';
import { openLocalePage, assertMirrored, assertNoHorizontalOverflow, runAxe, VIEWPORT } from './support/rtl';

/**
 * T052 — EN/AR-RTL + axe walkthrough of the full company setup wizard
 * (Acceptance Scenarios 3.1-3.7), including the mid-wizard language-switch
 * edge case. Backend calls are mocked at the network layer via `page.route`
 * (labelled here, not credited as the real backend) so this suite has no
 * dependency on a running Odoo/NestJS stack. This unit-style coverage is not used as
 * live acceptance evidence: `scripts/test_t052_live_browser.sh` drives the dedicated
 * `tests/e2e-live/t052-full-wizard.live.spec.ts` through real Keycloak/BFF/API/Odoo.
 */

const emptyState = { currentStep: 'country', setupComplete: false, values: {}, version: 0, stale: false, scope: 'e2e-scope' };

async function authenticated(page: Page, baseURL: string) {
  // Install the explicitly synthetic session at the browser-context boundary so it
  // survives LocaleSwitcher's real full-page reload. Do not navigate from this fixture:
  // each test must register its API routes before the first page load, otherwise the
  // real BFF correctly expires this deliberately non-backed test session.
  const secureCookieUrl = new URL(baseURL);
  secureCookieUrl.protocol = 'https:';
  await page.context().addCookies([
    {
      name: '__Host-kemfai_session',
      value: 'playwright-session',
      // Chromium requires a secure source URL when injecting a __Host- cookie. The
      // resulting host-only cookie is still sent to its localhost secure context.
      url: secureCookieUrl.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

for (const locale of ['en', 'ar'] as const) {
  test(`${locale}: fixed order, progress, field validation, config gap, back-preserves-values, finish`, async ({
    browser,
    baseURL,
  }) => {
    const messages = locale === 'ar' ? ar : en;
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      await authenticated(page, baseURL!);

      let putCalls = 0;
      let vatAttempts = 0;
      let savedValues: Record<string, unknown> = {};
      await page.route('**/api/companies/current/setup', async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyState) });
          return;
        }
        putCalls += 1;
        const body = route.request().postDataJSON() as { step: string; values: Record<string, unknown> };
        if (body.step === 'country' && putCalls === 1) {
          await route.fulfill({
            status: 422,
            contentType: 'application/json',
            body: JSON.stringify({ statusCode: 422, message: 'country is required.' }),
          });
          return;
        }
        if (body.step === 'vat_tax') {
          vatAttempts += 1;
          if (vatAttempts === 1) {
            await route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({
                statusCode: 409,
                message: 'No VAT/tax validation rule is configured for this country',
              }),
            });
            return;
          }
        }
        savedValues = { ...savedValues, ...body.values };
        const stepOrder = ['country', 'identity', 'currency', 'fiscal_year', 'vat_tax', 'industry', 'accounting_setup'];
        const nextStep = stepOrder[Math.min(stepOrder.indexOf(body.step) + 1, stepOrder.length - 1)];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            currentStep: nextStep,
            setupComplete: false,
            values: savedValues,
            version: putCalls,
            stale: false,
            scope: 'e2e-scope',
          }),
        });
      });
      await page.route('**/api/companies/current/setup/complete', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            currentStep: 'accounting_setup',
            setupComplete: true,
            values: savedValues,
            version: putCalls,
            stale: false,
            scope: 'e2e-scope',
          }),
        }),
      );

      await page.goto('/setup-wizard');
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.getByTestId('setup-wizard-progress')).toBeVisible();
      await expect(page.getByTestId('setup-wizard-progress').getByRole('button')).toHaveCount(7);
      expect(await page.getByTestId('setup-wizard-progress').getByRole('button').allTextContents()).toEqual([
        messages.setupWizard.steps.country,
        messages.setupWizard.steps.identity,
        messages.setupWizard.steps.currency,
        messages.setupWizard.steps.fiscal_year,
        messages.setupWizard.steps.vat_tax,
        messages.setupWizard.steps.industry,
        messages.setupWizard.steps.accounting_setup,
      ]);
      await expect(page.getByTestId('setup-wizard-step-country')).toHaveAttribute('aria-current', 'step');

      // Acceptance 3.6: invalid/missing required field blocks progression with a
      // field-level, localized error.
      await page.getByTestId('setup-wizard-next').click();
      await expect(page.getByTestId('setup-wizard-field-error')).toContainText(messages.setupWizard.fields.country.error);

      // Fix the field and proceed.
      await page.getByLabel(messages.setupWizard.fields.country.label).fill('AE');
      await page.getByTestId('setup-wizard-next').click();
      await expect(page.getByTestId('setup-wizard-step-identity')).toHaveAttribute('aria-current', 'step');

      await page.getByLabel(messages.setupWizard.fields.legal_name.label).fill('Acme Co');
      await page.getByLabel(messages.setupWizard.fields.trade_name.label).fill('Acme');
      await page.getByTestId('setup-wizard-next').click();
      await expect(page.getByTestId('setup-wizard-step-currency')).toHaveAttribute('aria-current', 'step');

      // Acceptance 3.3: navigate back, value is preserved and editable.
      await page.getByTestId('setup-wizard-back').click();
      await expect(page.getByLabel(messages.setupWizard.fields.legal_name.label)).toHaveValue('Acme Co');
      await page.getByTestId('setup-wizard-next').click();

      await page.getByLabel(messages.setupWizard.fields.base_currency.label).fill('AED');
      await page.getByTestId('setup-wizard-next').click();
      await expect(page.getByTestId('setup-wizard-step-fiscal_year')).toHaveAttribute('aria-current', 'step');

      await page.getByLabel(messages.setupWizard.fields.fiscal_year_start_month.label).selectOption('1');
      await page.getByLabel(messages.setupWizard.fields.fiscal_year_start_day.label).fill('1');
      await page.getByTestId('setup-wizard-next').click();
      await expect(page.getByTestId('setup-wizard-step-vat_tax')).toHaveAttribute('aria-current', 'step');

      // Acceptance 3.5 edge case: a country with no configured validation rule is a
      // configuration gap (409), not a silently accepted value.
      await page.getByLabel(messages.setupWizard.fields.vat_tax_registration.label).fill('TRN-1');
      await page.getByTestId('setup-wizard-next').click();
      await expect(page.getByTestId('setup-wizard-config-gap')).toContainText(messages.setupWizard.errors.configGap);

      // The configuration gap is recoverable once server configuration exists; retry
      // and finish every remaining fixed-order step in this explicitly mocked suite.
      await page.getByTestId('setup-wizard-next').click();
      await expect(page.getByTestId('setup-wizard-step-industry')).toHaveAttribute('aria-current', 'step');

      await page.getByLabel(messages.setupWizard.fields.industry.label).fill('1');
      await page.getByTestId('setup-wizard-next').click();
      await expect(page.getByTestId('setup-wizard-step-accounting_setup')).toHaveAttribute('aria-current', 'step');

      await page
        .getByLabel(messages.setupWizard.fields.accounting_setup_template.label)
        .selectOption('standard');
      await page.getByTestId('setup-wizard-next').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('setup-wizard-complete')).toContainText(messages.setupWizard.complete.title);
      await runAxe(page);
      await assertNoHorizontalOverflow(page);
    } finally {
      await context.close();
    }
  });
}

test('resume-at-first-incomplete-step and pause/resume are keyboard-operable', async ({ browser, baseURL }) => {
  const { context, page } = await openLocalePage(browser, baseURL!, 'en');
  try {
    await authenticated(page, baseURL!);
    let paused = false;
    await page.route('**/api/companies/current/setup', async (route) => {
      if (route.request().method() === 'GET') {
        const state = paused
          ? { currentStep: 'currency', setupComplete: false, values: { country: 'AE', legal_name: 'Acme', trade_name: 'Acme' }, version: 2, stale: false, scope: 'e2e-scope' }
          : emptyState;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) });
        return;
      }
      paused = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ currentStep: 'country', setupComplete: false, values: { country: 'AE' }, version: 1, stale: false, scope: 'e2e-scope' }),
      });
    });

    await page.goto('/setup-wizard');
    await page.getByLabel(en.setupWizard.fields.country.label).fill('AE');
    await page.keyboard.press('Tab');
    await page.getByTestId('setup-wizard-pause').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('setup-wizard-paused')).toBeVisible();

    await page.getByTestId('setup-wizard-resume').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('setup-wizard-step-currency')).toHaveAttribute('aria-current', 'step');
  } finally {
    await context.close();
  }
});

test('unit-style mocked API: real UI language switch on unsaved identity preserves input EN -> AR -> EN', async ({ browser, baseURL }) => {
  const { context, page } = await openLocalePage(browser, baseURL!, 'en');
  try {
    await authenticated(page, baseURL!);
    let currentStep = 'country';
    let savedValues: Record<string, unknown> = {};
    await page.route('**/api/companies/current/setup', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...emptyState, currentStep, values: savedValues, version: currentStep === 'country' ? 0 : 1 }),
        });
        return;
      }
      const body = route.request().postDataJSON() as { step: string; values: Record<string, unknown> };
      savedValues = { ...savedValues, ...body.values };
      currentStep = body.step === 'country' ? 'identity' : 'country';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...emptyState,
          currentStep,
          values: savedValues,
          version: 1,
        }),
      });
    });
    await page.route('**/api/accounts/me/locale', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ locale: 'ar' }) }),
    );

    await page.goto('/setup-wizard');
    await page.getByLabel(en.setupWizard.fields.country.label).fill('EG');
    await page.getByTestId('setup-wizard-next').click();
    await expect(page.getByTestId('setup-wizard-step-identity')).toHaveAttribute('aria-current', 'step');
    await page.getByLabel(en.setupWizard.fields.legal_name.label).fill('Unsaved Legal Name');
    await page.getByLabel(en.setupWizard.fields.trade_name.label).fill('Unsaved Trade Name');
    await page.getByTestId('locale-switcher').click();

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByLabel(ar.setupWizard.fields.legal_name.label)).toHaveValue('Unsaved Legal Name');
    await expect(page.getByLabel(ar.setupWizard.fields.trade_name.label)).toHaveValue('Unsaved Trade Name');
    await page.getByTestId('locale-switcher').click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByLabel(en.setupWizard.fields.legal_name.label)).toHaveValue('Unsaved Legal Name');
    await expect(page.getByLabel(en.setupWizard.fields.trade_name.label)).toHaveValue('Unsaved Trade Name');
    await runAxe(page);
  } finally {
    await context.close();
  }
});

test('session expiry and completion surfaces are distinct and accessible', async ({ browser, baseURL }) => {
  const english = await openLocalePage(browser, baseURL!, 'en');
  try {
    await authenticated(english.page, baseURL!);
    await english.page.route('**/api/companies/current/setup', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Authentication required' }) }),
    );
    await english.page.goto('/setup-wizard');
    await expect(english.page.getByTestId('setup-wizard-session-expired')).toContainText(en.setupWizard.errors.sessionExpired);
    await runAxe(english.page);
  } finally {
    await english.context.close();
  }

  const completing = await openLocalePage(browser, baseURL!, 'en');
  try {
    await authenticated(completing.page, baseURL!);
    const finalState = {
      currentStep: 'accounting_setup',
      setupComplete: false,
      values: {
        country: 'AE',
        legal_name: 'Acme',
        trade_name: 'Acme',
        base_currency: 'AED',
        fiscal_year_start_month: '1',
        fiscal_year_start_day: 1,
        vat_tax_registration: 'TRN-1',
      },
      version: 6,
      stale: false,
      scope: 'e2e-scope',
    };
    await completing.page.route('**/api/companies/current/setup', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(finalState) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...finalState, values: { ...finalState.values, accounting_setup_template: 'standard' } }),
      });
    });
    await completing.page.route('**/api/companies/current/setup/complete', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...finalState, setupComplete: true, values: { ...finalState.values, accounting_setup_template: 'standard' } }),
      }),
    );
    await completing.page.goto('/setup-wizard');
    await completing.page.getByLabel(en.setupWizard.fields.accounting_setup_template.label).selectOption('standard');
    await completing.page.getByTestId('setup-wizard-next').click();
    await expect(completing.page.getByTestId('setup-wizard-complete')).toContainText(en.setupWizard.complete.title);
    await runAxe(completing.page);
  } finally {
    await completing.context.close();
  }
});

test('EN/AR progress controls mirror in RTL', async ({ browser, baseURL }) => {
  const english = await openLocalePage(browser, baseURL!, 'en');
  const arabic = await openLocalePage(browser, baseURL!, 'ar');
  try {
    for (const { page } of [english, arabic]) {
      await authenticated(page, baseURL!);
      await page.route('**/api/companies/current/setup', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyState) }),
      );
      await page.goto('/setup-wizard');
    }
    await assertMirrored(
      english.page.getByTestId('setup-wizard-back'),
      arabic.page.getByTestId('setup-wizard-back'),
      VIEWPORT.width,
    );
  } finally {
    await english.context.close();
    await arabic.context.close();
  }
});
