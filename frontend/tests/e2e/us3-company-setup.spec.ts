import { test, expect, type Page } from '@playwright/test';
import en from '../../src/locales/en/common.json';
import ar from '../../src/locales/ar/common.json';
import { openLocalePage, assertMirrored, assertNoHorizontalOverflow, runAxe, VIEWPORT } from './support/rtl';

/**
 * T052 — EN/AR-RTL + axe walkthrough of the full company setup wizard
 * (Acceptance Scenarios 3.1-3.7), including the mid-wizard language-switch
 * edge case. Backend calls are mocked at the network layer via `page.route`
 * (labelled here, not credited as the real backend) so this suite has no
 * dependency on a running Odoo/NestJS stack; `tests/integration` covers the
 * real BFF/API vertical slice separately.
 */

const emptyState = { currentStep: 'country', setupComplete: false, values: {}, version: 0, stale: false, scope: 'e2e-scope' };

async function authenticated(page: Page, baseURL: string) {
  await page.route('**/auth/login?e2e-setup-wizard', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `${baseURL}/setup-wizard`,
        'set-cookie': '__Host-kemfai_session=playwright-session; Path=/; Secure; HttpOnly; SameSite=Lax',
      },
    }),
  );
  await page.goto('/auth/login?e2e-setup-wizard');
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
        const stepOrder = ['country', 'identity', 'currency', 'fiscal_year', 'vat_tax', 'industry', 'accounting_setup'];
        const nextStep = stepOrder[Math.min(stepOrder.indexOf(body.step) + 1, stepOrder.length - 1)];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            currentStep: nextStep,
            setupComplete: false,
            values: { ...body.values },
            version: putCalls,
            stale: false,
            scope: 'e2e-scope',
          }),
        });
      });

      await page.goto('/setup-wizard');
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.getByTestId('setup-wizard-progress')).toBeVisible();
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

test('mid-wizard language switch preserves unsaved input (Acceptance 3.2 edge case)', async ({ browser, baseURL }) => {
  const { context, page } = await openLocalePage(browser, baseURL!, 'en');
  try {
    await authenticated(page, baseURL!);
    await page.route('**/api/companies/current/setup', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyState) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyState) });
    });
    await page.route('**/api/accounts/me/locale', (route) => route.fulfill({ status: 401 }));

    await page.goto('/setup-wizard');
    await page.getByLabel(en.setupWizard.fields.country.label).fill('EG');
    await page.getByTestId('locale-switcher').click();

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByLabel(ar.setupWizard.fields.country.label)).toHaveValue('EG');
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
