import { test, expect, type Page } from '@playwright/test';

import enMessages from '../../src/locales/en/common.json';
import arMessages from '../../src/locales/ar/common.json';
import {
  VIEWPORT,
  openLocalePage,
  assertMirrored,
  assertHorizontalOrder,
  assertNoHorizontalOverflow,
  assertDirectionalIcons,
  runAxe,
} from './support/rtl';

/**
 * T030 — EN/AR-RTL geometry, flow-order, direction, localization, overflow,
 * and axe-accessibility coverage for the four US1 public/onboarding screens
 * (arbiter resolution, 2026-09-26). Every screen is loaded twice per
 * assertion — once with `KEMFAI_LOCALE=en`, once with `ar` — via two
 * independent, same-viewport browser contexts so both locales' live layouts
 * can be compared directly. Backend calls are mocked at the network layer
 * so this suite has no dependency on a running Odoo/NestJS stack.
 */

const PLANS_FIXTURE = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: { en: 'Starter', ar: 'المبتدئ' },
    monthlyPrice: 29,
    annualPrice: 290,
    currency: 'USD',
    features: [{ key: 'seats', name: { en: 'Seats', ar: 'المقاعد' }, limitValue: 5 }],
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    name: { en: 'Growth', ar: 'النمو' },
    monthlyPrice: 79,
    annualPrice: 790,
    currency: 'USD',
    features: [{ key: 'seats', name: { en: 'Seats', ar: 'المقاعد' }, limitValue: 25 }],
  },
];

async function mockPlans(page: Page): Promise<void> {
  await page.route('**/public/plans', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PLANS_FIXTURE),
    }),
  );
}

function assertLocalizedNoFallback(actual: string, expectedAr: string, forbiddenEn: string): void {
  expect(actual).toContain(expectedAr);
  expect(actual).not.toContain(forbiddenEn);
}

test.describe('T030 — Plans screen RTL mirroring', () => {
  test('billing-cycle fieldset, first plan card, first radio, first choose-plan link', async ({
    browser,
    baseURL,
  }) => {
    const { context: enContext, page: enPage } = await openLocalePage(browser, baseURL!, 'en');
    const { context: arContext, page: arPage } = await openLocalePage(browser, baseURL!, 'ar');

    try {
      await mockPlans(enPage);
      await mockPlans(arPage);

      await enPage.goto('/plans');
      await arPage.goto('/plans');

      await expect(enPage.getByTestId('plan-card').first()).toBeVisible();
      await expect(arPage.getByTestId('plan-card').first()).toBeVisible();

      await assertMirrored(
        enPage.getByTestId('billing-cycle-fieldset'),
        arPage.getByTestId('billing-cycle-fieldset'),
        VIEWPORT.width,
      );
      await assertMirrored(
        enPage.getByTestId('plan-card').first(),
        arPage.getByTestId('plan-card').first(),
        VIEWPORT.width,
      );
      await assertMirrored(
        enPage.getByTestId('billing-cycle-option').first(),
        arPage.getByTestId('billing-cycle-option').first(),
        VIEWPORT.width,
      );
      await assertMirrored(
        enPage.getByTestId('plan-choose-link').first(),
        arPage.getByTestId('plan-choose-link').first(),
        VIEWPORT.width,
      );

      // Flow reversal: the monthly/annual billing-cycle radios are a horizontal control group.
      await assertHorizontalOrder(
        [enPage.getByTestId('billing-cycle-option').nth(0), enPage.getByTestId('billing-cycle-option').nth(1)],
        'increasing',
      );
      await assertHorizontalOrder(
        [arPage.getByTestId('billing-cycle-option').nth(0), arPage.getByTestId('billing-cycle-option').nth(1)],
        'decreasing',
      );

      await assertDirectionalIcons(enPage, arPage);
      await assertNoHorizontalOverflow(enPage);
      await assertNoHorizontalOverflow(arPage);
      await runAxe(enPage);
      await runAxe(arPage);
    } finally {
      await enContext.close();
      await arContext.close();
    }
  });
});

test.describe('T030 — Signup screen RTL mirroring', () => {
  test('email/password/terms/submit anchors and localized planUnavailable error', async ({
    browser,
    baseURL,
  }) => {
    const { context: enContext, page: enPage } = await openLocalePage(browser, baseURL!, 'en');
    const { context: arContext, page: arPage } = await openLocalePage(browser, baseURL!, 'ar');

    try {
      // No ?plan= param: submitting deterministically raises the localized
      // "plan unavailable" alert with no backend/network call required.
      await enPage.goto('/signup');
      await arPage.goto('/signup');

      await assertMirrored(enPage.locator('#signup-email'), arPage.locator('#signup-email'), VIEWPORT.width);
      await assertMirrored(
        enPage.locator('#signup-password'),
        arPage.locator('#signup-password'),
        VIEWPORT.width,
      );
      await assertMirrored(
        enPage.locator('#signup-accepted-terms'),
        arPage.locator('#signup-accepted-terms'),
        VIEWPORT.width,
      );
      await assertMirrored(
        enPage.getByTestId('signup-submit-button'),
        arPage.getByTestId('signup-submit-button'),
        VIEWPORT.width,
      );

      // Signup's fields are block-stacked (one per row) rather than
      // sharing a row, so there is no horizontal control group to assert
      // flow-reversal ordering on for this screen (arbiter resolution
      // item 3 applies only where a horizontal group actually exists).

      await assertDirectionalIcons(enPage, arPage);
      await assertNoHorizontalOverflow(enPage);
      await assertNoHorizontalOverflow(arPage);
      await runAxe(enPage);
      await runAxe(arPage);

      await enPage.getByTestId('signup-submit-button').click();
      await arPage.getByTestId('signup-submit-button').click();

      const enAlert = enPage.locator('[role="alert"]:not(#__next-route-announcer__)');
      const arAlert = arPage.locator('[role="alert"]:not(#__next-route-announcer__)');
      await expect(enAlert).toBeVisible();
      await expect(arAlert).toBeVisible();

      await assertMirrored(enAlert, arAlert, VIEWPORT.width);

      const enAlertText = (await enAlert.textContent()) ?? '';
      const arAlertText = (await arAlert.textContent()) ?? '';
      expect(enAlertText).toContain(enMessages.signup.planUnavailable.message);
      assertLocalizedNoFallback(
        arAlertText,
        arMessages.signup.planUnavailable.message,
        enMessages.signup.planUnavailable.message,
      );

      await assertDirectionalIcons(enPage, arPage);
      await assertNoHorizontalOverflow(enPage);
      await assertNoHorizontalOverflow(arPage);
      await runAxe(enPage);
      await runAxe(arPage);
    } finally {
      await enContext.close();
      await arContext.close();
    }
  });
});

test.describe('T030 — Verify screen RTL mirroring', () => {
  test('resend email/button anchors and localized invalid-link content', async ({ browser, baseURL }) => {
    const { context: enContext, page: enPage } = await openLocalePage(browser, baseURL!, 'en');
    const { context: arContext, page: arPage } = await openLocalePage(browser, baseURL!, 'ar');

    try {
      // No ?token= param: renders the "invalid link" state directly, with no
      // network call required.
      await enPage.goto('/verify');
      await arPage.goto('/verify');

      await assertMirrored(
        enPage.locator('#resend-email'),
        arPage.locator('#resend-email'),
        VIEWPORT.width,
      );
      await assertMirrored(
        enPage.getByTestId('verify-resend-button'),
        arPage.getByTestId('verify-resend-button'),
        VIEWPORT.width,
      );
      await assertMirrored(
        enPage.getByTestId('verify-invalid-message'),
        arPage.getByTestId('verify-invalid-message'),
        VIEWPORT.width,
      );

      // Flow reversal: the resend email input and its submit button share a row.
      await assertHorizontalOrder(
        [enPage.locator('#resend-email'), enPage.getByTestId('verify-resend-button')],
        'increasing',
      );
      await assertHorizontalOrder(
        [arPage.locator('#resend-email'), arPage.getByTestId('verify-resend-button')],
        'decreasing',
      );

      const enInvalidText = (await enPage.getByTestId('verify-invalid-message').textContent()) ?? '';
      const arInvalidText = (await arPage.getByTestId('verify-invalid-message').textContent()) ?? '';
      expect(enInvalidText).toContain(enMessages.verifyEmail.invalid.title);
      assertLocalizedNoFallback(
        arInvalidText,
        arMessages.verifyEmail.invalid.title,
        enMessages.verifyEmail.invalid.title,
      );

      await assertDirectionalIcons(enPage, arPage);
      await assertNoHorizontalOverflow(enPage);
      await assertNoHorizontalOverflow(arPage);
      await runAxe(enPage);
      await runAxe(arPage);
    } finally {
      await enContext.close();
      await arContext.close();
    }
  });
});

test.describe('T030 — MFA screen RTL mirroring', () => {
  test('idle enable/skip anchors and localized error content', async ({ browser, baseURL }) => {
    const { context: enContext, page: enPage } = await openLocalePage(browser, baseURL!, 'en');
    const { context: arContext, page: arPage } = await openLocalePage(browser, baseURL!, 'ar');

    try {
      await enPage.goto('/mfa');
      await arPage.goto('/mfa');

      await assertMirrored(
        enPage.getByTestId('mfa-enable-button'),
        arPage.getByTestId('mfa-enable-button'),
        VIEWPORT.width,
      );
      await assertMirrored(
        enPage.getByTestId('mfa-skip-button'),
        arPage.getByTestId('mfa-skip-button'),
        VIEWPORT.width,
      );

      // The primary "enable" action and "skip" nav control are each
      // block-stacked on their own row (not a horizontal control group),
      // so no flow-reversal ordering assertion applies here.

      await assertDirectionalIcons(enPage, arPage);
      await assertNoHorizontalOverflow(enPage);
      await assertNoHorizontalOverflow(arPage);
      await runAxe(enPage);
      await runAxe(arPage);

      // Force the enrollment POST to fail so the localized error/status
      // content anchor is deterministically reachable without a live backend.
      await enPage.route('**/api/accounts/mfa/enroll', (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
      );
      await arPage.route('**/api/accounts/mfa/enroll', (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
      );

      await enPage.getByTestId('mfa-enable-button').click();
      await arPage.getByTestId('mfa-enable-button').click();

      const enAlert = enPage.locator('[role="alert"]:not(#__next-route-announcer__)');
      const arAlert = arPage.locator('[role="alert"]:not(#__next-route-announcer__)');
      await expect(enAlert).toBeVisible();
      await expect(arAlert).toBeVisible();

      await assertMirrored(enAlert, arAlert, VIEWPORT.width);

      const enAlertText = (await enAlert.textContent()) ?? '';
      const arAlertText = (await arAlert.textContent()) ?? '';
      expect(enAlertText).toContain(enMessages.mfa.error);
      assertLocalizedNoFallback(arAlertText, arMessages.mfa.error, enMessages.mfa.error);

      await assertDirectionalIcons(enPage, arPage);
      await assertNoHorizontalOverflow(enPage);
      await assertNoHorizontalOverflow(arPage);
      await runAxe(enPage);
      await runAxe(arPage);
    } finally {
      await enContext.close();
      await arContext.close();
    }
  });

  test('setup-state open/confirm anchors mirror and reverse order', async ({ browser, baseURL }) => {
    const { context: enContext, page: enPage } = await openLocalePage(browser, baseURL!, 'en');
    const { context: arContext, page: arPage } = await openLocalePage(browser, baseURL!, 'ar');

    try {
      await enPage.goto('/mfa?setup=returned');
      await arPage.goto('/mfa?setup=returned');

      await assertMirrored(
        enPage.getByTestId('mfa-setup-open-button'),
        arPage.getByTestId('mfa-setup-open-button'),
        VIEWPORT.width,
      );
      await assertMirrored(
        enPage.getByTestId('mfa-confirm-button'),
        arPage.getByTestId('mfa-confirm-button'),
        VIEWPORT.width,
      );

      // "Open setup" and "confirm" are each block-stacked on their own
      // row (not a horizontal control group), so no flow-reversal
      // ordering assertion applies here.

      await assertDirectionalIcons(enPage, arPage);
      await assertNoHorizontalOverflow(enPage);
      await assertNoHorizontalOverflow(arPage);
      await runAxe(enPage);
      await runAxe(arPage);
    } finally {
      await enContext.close();
      await arContext.close();
    }
  });
});
