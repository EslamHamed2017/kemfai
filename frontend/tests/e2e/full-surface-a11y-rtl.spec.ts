import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';

import ar from '../../src/locales/ar/common.json';
import en from '../../src/locales/en/common.json';
import {
  VIEWPORT,
  assertDirectionalIcons,
  assertHorizontalOrder,
  assertMirrored,
  assertNoHorizontalOverflow,
  openLocalePage,
  runAxe,
  type Locale,
} from './support/rtl';

/**
 * T095 — the independent, full-surface FR-013/FR-014/SC-005 sweep.
 *
 * Every entry below is a genuine Next.js route rendered in Chromium. Browser
 * routes provide deterministic responses only to the real UI's client requests;
 * the support-access SSR eligibility read is seeded through the owned synthetic
 * stub API because Playwright browser interception cannot intercept server fetches.
 */

test.describe.configure({ timeout: 90_000 });

const STUB_ORIGIN = 'http://127.0.0.1:4100';
const PLAN_ID = '95000000-0000-4000-8000-000000000001';

const plans = [
  {
    id: PLAN_ID,
    name: { en: 'Starter', ar: 'المبتدئ' },
    monthlyPrice: 1250,
    annualPrice: 12500,
    currency: 'AED',
    features: [{ key: 'seats', name: { en: 'Seats', ar: 'المقاعد' }, limitValue: 5 }],
  },
  {
    id: '95000000-0000-4000-8000-000000000002',
    name: { en: 'Growth', ar: 'النمو' },
    monthlyPrice: 2500,
    annualPrice: 25000,
    currency: 'AED',
    features: [{ key: 'seats', name: { en: 'Seats', ar: 'المقاعد' }, limitValue: 25 }],
  },
];

const modules = [
  {
    key: 'module.sales',
    name: 'Sales',
    nameAr: 'المبيعات',
    includedInCurrentPlan: true,
    selected: true,
    requiredPlanTier: null,
    requiredPlanTierAr: null,
  },
  {
    key: 'module.inventory',
    name: 'Inventory',
    nameAr: 'المخزون',
    includedInCurrentPlan: true,
    selected: false,
    requiredPlanTier: null,
    requiredPlanTierAr: null,
  },
  {
    key: 'module.projects',
    name: 'Projects',
    nameAr: 'المشاريع',
    includedInCurrentPlan: false,
    selected: false,
    requiredPlanTier: 'Growth',
    requiredPlanTierAr: 'النمو',
  },
];

const checklistState = {
  customerAdded: false,
  bankAdded: false,
  productAdded: false,
  firstInvoiceReady: false,
  gatedOnSubscriptionActivation: true,
};

const subscription = {
  status: 'PendingActivation',
  billingPeriodStart: '2026-10-01',
  billingPeriodEnd: '2026-10-31',
  amountDue: 1250,
  currency: 'AED',
  paymentReference: 'T095-PAYMENT-REFERENCE',
};

const pendingSubmission = {
  id: '95000000-0000-4000-8000-000000000060',
  status: 'PendingReview',
  submittedAt: '2026-10-10T12:00:00.000Z',
  statusHistory: [{ status: 'PendingReview', changedAt: '2026-10-10T12:00:00.000Z' }],
};

const reviewSubmission = {
  ...pendingSubmission,
  id: '95000000-0000-4000-8000-000000000071',
  customerEmail: 'customer@example.test',
  tenantId: '95000000-0000-4000-8000-000000000072',
  planName: 'Growth',
  billingPeriodStart: '2026-10-01',
  billingPeriodEnd: '2026-10-31',
  amount: 1250,
  currency: 'AED',
  bankReference: 'T095-BANK-REFERENCE',
  proofDownloadUrl: 'https://untrusted.example.test/proof',
};

const supportGrant = {
  id: '95000000-0000-4000-8000-000000000087',
  granteeRole: 'Support',
  grantedBy: 'owner@example.test',
  grantedAt: '2026-10-20T10:00:00.000Z',
  expiresAt: '2026-10-25T10:00:00.000Z',
  revokedAt: null,
  expiredAt: null,
  status: 'active',
  permittedActions: ['workspace.summary.read'],
  usage: [
    {
      id: '95000000-0000-4000-8000-000000000088',
      usedBy: 'supporter@example.test',
      usedAt: '2026-10-21T09:00:00.000Z',
      actionSummary: 'workspace.summary.read',
      wasDenied: true,
      denialReason: 'wrong_tenant',
    },
  ],
} as const;

interface LocalePage {
  context: BrowserContext;
  page: Page;
}

interface LocalePair {
  en: LocalePage;
  ar: LocalePage;
}

async function openPair(browser: Browser, baseURL: string): Promise<LocalePair> {
  const [english, arabic] = await Promise.all([
    openLocalePage(browser, baseURL, 'en'),
    openLocalePage(browser, baseURL, 'ar'),
  ]);
  return { en: english, ar: arabic };
}

async function closePair(pair: LocalePair): Promise<void> {
  await Promise.all([pair.en.context.close(), pair.ar.context.close()]);
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function seedSession(
  page: Page,
  baseURL: string,
  surface: string,
  locale: Locale,
  internal = false,
): Promise<string> {
  const sessionId = `t095-${surface}-${locale}-session`;
  const token = `t095-${surface}-${locale}-token`;
  const response = await page.request.post(`${STUB_ORIGIN}/__e2e/seed`, {
    data: { sessionId, token, locale },
  });
  expect(response.status()).toBe(204);

  const secureURL = new URL(baseURL);
  secureURL.protocol = 'https:';
  await page.context().addCookies([
    {
      name: internal ? '__Host-kemfai_internal_session' : '__Host-kemfai_session',
      value: sessionId,
      url: secureURL.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  return token;
}

async function seedPairSessions(
  pair: LocalePair,
  baseURL: string,
  surface: string,
  internal = false,
): Promise<{ en: string; ar: string }> {
  const [enToken, arToken] = await Promise.all([
    seedSession(pair.en.page, baseURL, surface, 'en', internal),
    seedSession(pair.ar.page, baseURL, surface, 'ar', internal),
  ]);
  return { en: enToken, ar: arToken };
}

/**
 * Walk the actual sequential focus order from the document start. This proves
 * every visible, enabled native control/link on the rendered state is reachable
 * using Tab, rather than merely calling locator.focus() on one convenient item.
 */
async function assertKeyboardTraversal(page: Page): Promise<void> {
  const focusableCount = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href],button,input,select,textarea,summary,[tabindex]',
      ),
    );
    return candidates.filter((candidate) => {
      if (candidate.tabIndex < 0 || candidate.matches(':disabled')) return false;
      if (candidate.closest('[inert],[aria-hidden="true"]')) return false;
      const style = getComputedStyle(candidate);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (candidate.getClientRects().length === 0) return false;
      if (candidate instanceof HTMLInputElement && candidate.type === 'radio' && candidate.name) {
        const group = candidates.filter(
          (item): item is HTMLInputElement =>
            item instanceof HTMLInputElement &&
            item.type === 'radio' &&
            item.name === candidate.name &&
            item.form === candidate.form &&
            !item.disabled,
        );
        const tabStop = group.find((item) => item.checked) ?? group[0];
        return candidate === tabStop;
      }
      return true;
    }).length;
  });

  expect(focusableCount, 'the rendered screen must expose keyboard controls').toBeGreaterThan(0);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    window.scrollTo(0, 0);
  });

  const seen = new Set<number>();
  let previousIndex: number | null = null;
  const maximumTabPresses = focusableCount * 8;
  for (let press = 0; press < maximumTabPresses && seen.size < focusableCount; press += 1) {
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          'a[href],button,input,select,textarea,summary,[tabindex]',
        ),
      );
      const focusable = candidates.filter((candidate) => {
        if (candidate.tabIndex < 0 || candidate.matches(':disabled')) return false;
        if (candidate.closest('[inert],[aria-hidden="true"]')) return false;
        const style = getComputedStyle(candidate);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (candidate.getClientRects().length === 0) return false;
        if (candidate instanceof HTMLInputElement && candidate.type === 'radio' && candidate.name) {
          const group = candidates.filter(
            (item): item is HTMLInputElement =>
              item instanceof HTMLInputElement &&
              item.type === 'radio' &&
              item.name === candidate.name &&
              item.form === candidate.form &&
              !item.disabled,
          );
          const tabStop = group.find((item) => item.checked) ?? group[0];
          return candidate === tabStop;
        }
        return true;
      });
      const element = document.activeElement as HTMLElement;
      return {
        index: focusable.indexOf(element),
        allowsInternalTabStops:
          element instanceof HTMLInputElement &&
          ['date', 'datetime-local', 'month', 'time', 'week'].includes(element.type),
      };
    });
    expect(
      active.index,
      `Tab press ${press + 1} must focus a rendered control`,
    ).toBeGreaterThanOrEqual(0);

    if (seen.has(active.index)) {
      expect(active.index, `Tab press ${press + 1} must not loop to an earlier control`).toBe(
        previousIndex,
      );
      expect(
        active.allowsInternalTabStops,
        `Tab press ${press + 1} may repeat only inside a native date/time control`,
      ).toBe(true);
    } else {
      expect(
        active.index,
        `Tab press ${press + 1} must reach the next rendered control without skipping`,
      ).toBe(seen.size);
      seen.add(active.index);
    }
    previousIndex = active.index;
  }
  expect(
    seen.size,
    `Tab traversal must reach all ${focusableCount} rendered controls before looping`,
  ).toBe(focusableCount);
}

async function assertLocale(page: Page, locale: Locale, heading: string): Promise<void> {
  const direction = locale === 'ar' ? 'rtl' : 'ltr';
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.locator('html')).toHaveAttribute('dir', direction);
  await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
  expect(
    await page.locator('main').evaluate((element) => getComputedStyle(element).direction),
  ).toBe(direction);
}

async function assertSurfacePair(
  pair: LocalePair,
  headings: { en: string; ar: string },
  anchors: { en: Locator; ar: Locator },
): Promise<void> {
  await Promise.all([
    assertLocale(pair.en.page, 'en', headings.en),
    assertLocale(pair.ar.page, 'ar', headings.ar),
  ]);
  await assertMirrored(anchors.en, anchors.ar, VIEWPORT.width);
  await assertDirectionalIcons(pair.en.page, pair.ar.page);
  await Promise.all([
    assertNoHorizontalOverflow(pair.en.page),
    assertNoHorizontalOverflow(pair.ar.page),
    assertKeyboardTraversal(pair.en.page),
    assertKeyboardTraversal(pair.ar.page),
  ]);
  await Promise.all([runAxe(pair.en.page), runAxe(pair.ar.page)]);
}

async function installModulesFixture(page: Page): Promise<void> {
  let selected = modules.filter((option) => option.selected).map((option) => option.key);
  await page.route('**/api/modules', (route) =>
    fulfillJson(
      route,
      200,
      modules.map((option) => ({ ...option, selected: selected.includes(option.key) })),
    ),
  );
  await page.route('**/api/modules/selection', async (route) => {
    selected = (route.request().postDataJSON() as { featureKeys: string[] }).featureKeys;
    await fulfillJson(route, 200, { featureKeys: selected });
  });
}

async function installChecklistFixture(page: Page): Promise<void> {
  await page.route('**/api/onboarding/checklist', (route) =>
    fulfillJson(route, 200, checklistState),
  );
}

test('public plans — EN/AR copy, mirrored cycle/cards, keyboard selection, overflow, and axe', async ({
  browser,
  baseURL,
}) => {
  const pair = await openPair(browser, baseURL!);
  try {
    for (const { page } of [pair.en, pair.ar]) {
      await page.route('**/public/plans', (route) => fulfillJson(route, 200, plans));
      await page.goto('/plans');
      await expect(page.getByTestId('plan-card')).toHaveCount(2);
    }

    await expect(pair.en.page.getByText(en.plans.intro, { exact: true })).toBeVisible();
    await expect(pair.ar.page.getByText(ar.plans.intro, { exact: true })).toBeVisible();
    await expect(pair.ar.page.getByText(en.plans.intro, { exact: true })).toHaveCount(0);
    await assertHorizontalOrder(
      [
        pair.en.page.getByTestId('billing-cycle-option').nth(0),
        pair.en.page.getByTestId('billing-cycle-option').nth(1),
      ],
      'increasing',
    );
    await assertHorizontalOrder(
      [
        pair.ar.page.getByTestId('billing-cycle-option').nth(0),
        pair.ar.page.getByTestId('billing-cycle-option').nth(1),
      ],
      'decreasing',
    );
    await assertSurfacePair(
      pair,
      { en: en.plans.title, ar: ar.plans.title },
      {
        en: pair.en.page.getByTestId('plan-card').first(),
        ar: pair.ar.page.getByTestId('plan-card').first(),
      },
    );

    for (const { page } of [pair.en, pair.ar]) {
      const annual = page.getByTestId('billing-cycle-option').nth(1);
      await annual.focus();
      await page.keyboard.press('Space');
      await expect(annual).toBeChecked();
    }
  } finally {
    await closePair(pair);
  }
});

test('signup — EN/AR form labels, mirrored controls, keyboard error path, overflow, and axe', async ({
  browser,
  baseURL,
}) => {
  const pair = await openPair(browser, baseURL!);
  try {
    await Promise.all([pair.en.page.goto('/signup'), pair.ar.page.goto('/signup')]);
    await expect(pair.en.page.getByLabel(en.signup.emailLabel)).toBeVisible();
    await expect(pair.ar.page.getByLabel(ar.signup.emailLabel)).toBeVisible();
    await expect(pair.ar.page.getByText(en.signup.passwordHint, { exact: true })).toHaveCount(0);
    await assertSurfacePair(
      pair,
      { en: en.signup.title, ar: ar.signup.title },
      { en: pair.en.page.locator('#signup-email'), ar: pair.ar.page.locator('#signup-email') },
    );

    for (const { locale, page } of [
      { locale: 'en' as const, page: pair.en.page },
      { locale: 'ar' as const, page: pair.ar.page },
    ]) {
      await page.getByTestId('signup-submit-button').focus();
      await page.keyboard.press('Enter');
      const signupAlert = page.locator('main [role="alert"]');
      await expect(signupAlert).toHaveCount(1);
      await expect(signupAlert).toContainText(
        locale === 'ar' ? ar.signup.planUnavailable.message : en.signup.planUnavailable.message,
      );
      await runAxe(page);
    }
  } finally {
    await closePair(pair);
  }
});

test('verification — EN/AR invalid-link recovery, mirrored flow, keyboard resend, overflow, and axe', async ({
  browser,
  baseURL,
}) => {
  const pair = await openPair(browser, baseURL!);
  try {
    for (const { page } of [pair.en, pair.ar]) {
      await page.route('**/accounts/resend-verification', (route) => fulfillJson(route, 202, {}));
      await page.goto('/verify');
    }
    await expect(
      pair.en.page.getByText(en.verifyEmail.invalid.body, { exact: true }),
    ).toBeVisible();
    await expect(
      pair.ar.page.getByText(ar.verifyEmail.invalid.body, { exact: true }),
    ).toBeVisible();
    await assertHorizontalOrder(
      [pair.en.page.locator('#resend-email'), pair.en.page.getByTestId('verify-resend-button')],
      'increasing',
    );
    await assertHorizontalOrder(
      [pair.ar.page.locator('#resend-email'), pair.ar.page.getByTestId('verify-resend-button')],
      'decreasing',
    );
    await assertSurfacePair(
      pair,
      { en: en.verifyEmail.invalid.title, ar: ar.verifyEmail.invalid.title },
      { en: pair.en.page.locator('#resend-email'), ar: pair.ar.page.locator('#resend-email') },
    );

    for (const { locale, page } of [
      { locale: 'en' as const, page: pair.en.page },
      { locale: 'ar' as const, page: pair.ar.page },
    ]) {
      await page.locator('#resend-email').fill('owner@example.test');
      await page.getByTestId('verify-resend-button').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('status')).toHaveText(
        locale === 'ar' ? ar.verifyEmail.resend.confirmation : en.verifyEmail.resend.confirmation,
      );
    }
  } finally {
    await closePair(pair);
  }
});

test('MFA — EN/AR optional enrollment, mirrored controls, keyboard failure path, overflow, and axe', async ({
  browser,
  baseURL,
}) => {
  const pair = await openPair(browser, baseURL!);
  try {
    for (const { page } of [pair.en, pair.ar]) {
      await page.route('**/api/accounts/mfa/enroll', (route) => fulfillJson(route, 500, {}));
      await page.goto('/mfa');
    }
    await expect(pair.en.page.getByText(en.mfa.optional, { exact: true })).toBeVisible();
    await expect(pair.ar.page.getByText(ar.mfa.optional, { exact: true })).toBeVisible();
    await assertSurfacePair(
      pair,
      { en: en.mfa.title, ar: ar.mfa.title },
      {
        en: pair.en.page.getByTestId('mfa-enable-button'),
        ar: pair.ar.page.getByTestId('mfa-enable-button'),
      },
    );
    for (const { locale, page } of [
      { locale: 'en' as const, page: pair.en.page },
      { locale: 'ar' as const, page: pair.ar.page },
    ]) {
      await page.getByTestId('mfa-enable-button').focus();
      await page.keyboard.press('Enter');
      const mfaAlert = page.locator('main [role="alert"]');
      await expect(mfaAlert).toHaveCount(1);
      await expect(mfaAlert).toHaveText(locale === 'ar' ? ar.mfa.error : en.mfa.error);
      await runAxe(page);
    }
  } finally {
    await closePair(pair);
  }
});

test('provisioning — EN/AR recoverable failure, mirrored actions, keyboard retry, overflow, and axe', async ({
  browser,
  baseURL,
}) => {
  const pair = await openPair(browser, baseURL!);
  try {
    await seedPairSessions(pair, baseURL!, 'provisioning');
    for (const { page } of [pair.en, pair.ar]) {
      let status: 'Failed' | 'Pending' = 'Failed';
      await page.route('**/api/tenants/me', (route) => fulfillJson(route, 200, { status }));
      await page.route('**/api/tenants/me/provisioning-retry', async (route) => {
        status = 'Pending';
        await fulfillJson(route, 202, { status });
      });
      await page.goto('/provisioning');
      await expect(page.getByTestId('provisioning-failure')).toBeVisible();
    }
    await expect(
      pair.en.page.getByRole('heading', { name: en.provisioning.failed.title }),
    ).toBeVisible();
    await expect(
      pair.ar.page.getByRole('heading', { name: ar.provisioning.failed.title }),
    ).toBeVisible();
    await assertSurfacePair(
      pair,
      { en: en.provisioning.title, ar: ar.provisioning.title },
      {
        en: pair.en.page.getByTestId('provisioning-retry'),
        ar: pair.ar.page.getByTestId('provisioning-retry'),
      },
    );
    for (const { page } of [pair.en, pair.ar]) {
      await page.getByTestId('provisioning-retry').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('provisioning-loading')).toBeVisible();
      await runAxe(page);
    }
  } finally {
    await closePair(pair);
  }
});

async function installWizardFixture(page: Page): Promise<void> {
  const order = [
    'country',
    'identity',
    'currency',
    'fiscal_year',
    'vat_tax',
    'industry',
    'accounting_setup',
  ];
  let currentStep = order[0];
  let values: Record<string, unknown> = {};
  let version = 0;
  const state = (setupComplete = false) => ({
    currentStep,
    setupComplete,
    values,
    version,
    stale: false,
    scope: 't095-wizard-scope',
  });
  await page.route('**/api/companies/current/setup', async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, 200, state());
      return;
    }
    const body = route.request().postDataJSON() as {
      step: string;
      values: Record<string, unknown>;
    };
    values = { ...values, ...body.values };
    version += 1;
    currentStep = order[Math.min(order.indexOf(body.step) + 1, order.length - 1)];
    await fulfillJson(route, 200, state());
  });
  await page.route('**/api/companies/current/setup/complete', (route) =>
    fulfillJson(route, 200, state(true)),
  );
}

async function fillWizardStep(page: Page, step: string): Promise<void> {
  if (step === 'country') await page.locator('#setup-wizard-country').fill('AE');
  if (step === 'identity') {
    await page.locator('#setup-wizard-legal_name').fill('Acme Legal');
    await page.locator('#setup-wizard-trade_name').fill('Acme');
  }
  if (step === 'currency') await page.locator('#setup-wizard-base_currency').fill('AED');
  if (step === 'fiscal_year') {
    await page.locator('#setup-wizard-fiscal_year_start_month').selectOption('1');
    await page.locator('#setup-wizard-fiscal_year_start_day').fill('1');
  }
  if (step === 'vat_tax') await page.locator('#setup-wizard-vat_tax_registration').fill('TRN-095');
  if (step === 'industry') await page.locator('#setup-wizard-industry').fill('95');
  if (step === 'accounting_setup') {
    await page.locator('#setup-wizard-accounting_setup_template').selectOption('standard');
  }
}

test('setup wizard — every step is localized, mirrored, keyboard-advanced, unclipped, and axe-clean', async ({
  browser,
  baseURL,
}) => {
  const pair = await openPair(browser, baseURL!);
  try {
    await seedPairSessions(pair, baseURL!, 'wizard');
    for (const { page } of [pair.en, pair.ar]) {
      await installWizardFixture(page);
      await page.goto('/setup-wizard');
      await expect(page.getByTestId('setup-wizard-step-country')).toHaveAttribute(
        'aria-current',
        'step',
      );
    }
    await assertSurfacePair(
      pair,
      { en: en.setupWizard.title, ar: ar.setupWizard.title },
      {
        en: pair.en.page.getByTestId('setup-wizard-fieldset'),
        ar: pair.ar.page.getByTestId('setup-wizard-fieldset'),
      },
    );

    const steps = [
      'country',
      'identity',
      'currency',
      'fiscal_year',
      'vat_tax',
      'industry',
      'accounting_setup',
    ] as const;
    await expect(pair.en.page.getByTestId('setup-wizard-progress').getByRole('button')).toHaveText(
      steps.map((step) => en.setupWizard.steps[step]),
    );
    await expect(pair.ar.page.getByTestId('setup-wizard-progress').getByRole('button')).toHaveText(
      steps.map((step) => ar.setupWizard.steps[step]),
    );

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      await Promise.all([
        expect(
          pair.en.page.getByRole('heading', { level: 2, name: en.setupWizard.steps[step] }),
        ).toBeVisible(),
        expect(
          pair.ar.page.getByRole('heading', { level: 2, name: ar.setupWizard.steps[step] }),
        ).toBeVisible(),
      ]);
      await assertMirrored(
        pair.en.page.getByTestId('setup-wizard-fieldset'),
        pair.ar.page.getByTestId('setup-wizard-fieldset'),
        VIEWPORT.width,
      );
      if (index > 0) {
        await Promise.all([
          assertNoHorizontalOverflow(pair.en.page),
          assertNoHorizontalOverflow(pair.ar.page),
          runAxe(pair.en.page),
          runAxe(pair.ar.page),
        ]);
      }
      await Promise.all([fillWizardStep(pair.en.page, step), fillWizardStep(pair.ar.page, step)]);
      for (const { page } of [pair.en, pair.ar]) {
        await page.getByTestId('setup-wizard-next').focus();
        await page.keyboard.press('Enter');
      }
      if (index < steps.length - 1) {
        await Promise.all([
          expect(pair.en.page.getByTestId(`setup-wizard-step-${steps[index + 1]}`)).toHaveAttribute(
            'aria-current',
            'step',
          ),
          expect(pair.ar.page.getByTestId(`setup-wizard-step-${steps[index + 1]}`)).toHaveAttribute(
            'aria-current',
            'step',
          ),
        ]);
      }
    }

    await expect(pair.en.page.getByTestId('setup-wizard-complete')).toContainText(
      en.setupWizard.complete.title,
    );
    await expect(pair.ar.page.getByTestId('setup-wizard-complete')).toContainText(
      ar.setupWizard.complete.title,
    );
    await Promise.all([runAxe(pair.en.page), runAxe(pair.ar.page)]);
  } finally {
    await closePair(pair);
  }
});

test('module selection — EN/AR cards, mirrored flow, keyboard save, overflow, and axe', async ({
  browser,
  baseURL,
}) => {
  const pair = await openPair(browser, baseURL!);
  try {
    await seedPairSessions(pair, baseURL!, 'modules');
    for (const { page } of [pair.en, pair.ar]) {
      await installModulesFixture(page);
      await page.goto('/modules');
      await expect(page.locator('.kemfai-module-card')).toHaveCount(3);
    }
    await expect(pair.en.page.getByText(en.moduleSelection.intro, { exact: true })).toBeVisible();
    await expect(pair.ar.page.getByText(ar.moduleSelection.intro, { exact: true })).toBeVisible();
    await assertHorizontalOrder(
      [pair.en.page.getByTestId('locale-switcher'), pair.en.page.getByTestId('sign-out-button')],
      'increasing',
    );
    await assertHorizontalOrder(
      [pair.ar.page.getByTestId('locale-switcher'), pair.ar.page.getByTestId('sign-out-button')],
      'decreasing',
    );
    await assertSurfacePair(
      pair,
      { en: en.moduleSelection.title, ar: ar.moduleSelection.title },
      {
        en: pair.en.page.locator('.kemfai-module-card').first(),
        ar: pair.ar.page.locator('.kemfai-module-card').first(),
      },
    );

    for (const { locale, page } of [
      { locale: 'en' as const, page: pair.en.page },
      { locale: 'ar' as const, page: pair.ar.page },
    ]) {
      const inventory = page.getByLabel(locale === 'ar' ? 'المخزون' : 'Inventory');
      await inventory.focus();
      await page.keyboard.press('Space');
      await expect(inventory).toBeChecked();
      await page.getByTestId('module-selection-save').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('module-selection-success')).toContainText(
        locale === 'ar' ? ar.moduleSelection.saved : en.moduleSelection.saved,
      );
      await runAxe(page);
    }
  } finally {
    await closePair(pair);
  }
});

async function installBillingFixture(page: Page, locale: Locale): Promise<void> {
  let submissions: unknown[] = [];
  await page.route('**/api/billing/subscription', (route) =>
    fulfillJson(route, 200, {
      ...subscription,
      bankInstructions:
        locale === 'ar'
          ? 'حوّل المبلغ إلى الحساب البنكي التجريبي الخاص بـ T095.'
          : 'Transfer to the T095 synthetic bank account.',
    }),
  );
  await page.route('**/api/billing/payment-submissions', async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, 200, submissions);
      return;
    }
    submissions = [pendingSubmission];
    await fulfillJson(route, 201, pendingSubmission);
  });
}

test('billing/payment proof — EN/AR copy and numerals, mirrored form, keyboard submit, overflow, and axe', async ({
  browser,
  baseURL,
}) => {
  const pair = await openPair(browser, baseURL!);
  try {
    await seedPairSessions(pair, baseURL!, 'billing');
    await installBillingFixture(pair.en.page, 'en');
    await installBillingFixture(pair.ar.page, 'ar');
    await Promise.all([pair.en.page.goto('/billing'), pair.ar.page.goto('/billing')]);
    await Promise.all([
      expect(pair.en.page.getByTestId('billing-screen')).toBeVisible(),
      expect(pair.ar.page.getByTestId('billing-screen')).toBeVisible(),
    ]);
    await expect(
      pair.en.page.getByRole('heading', { level: 2, name: en.billing.form.title, exact: true }),
    ).toBeVisible();
    await expect(
      pair.ar.page.getByRole('heading', { level: 2, name: ar.billing.form.title, exact: true }),
    ).toBeVisible();
    await expect(pair.ar.page.getByTestId('billing-amount-due')).toContainText('١٬٢٥٠');
    await expect(pair.ar.page.getByTestId('billing-amount-due')).not.toContainText('1,250');
    await assertHorizontalOrder(
      [pair.en.page.getByTestId('locale-switcher'), pair.en.page.getByTestId('sign-out-button')],
      'increasing',
    );
    await assertHorizontalOrder(
      [pair.ar.page.getByTestId('locale-switcher'), pair.ar.page.getByTestId('sign-out-button')],
      'decreasing',
    );
    await assertSurfacePair(
      pair,
      { en: en.billing.title, ar: ar.billing.title },
      {
        en: pair.en.page.getByTestId('billing-upload-form'),
        ar: pair.ar.page.getByTestId('billing-upload-form'),
      },
    );

    for (const { locale, page } of [
      { locale: 'en' as const, page: pair.en.page },
      { locale: 'ar' as const, page: pair.ar.page },
    ]) {
      await page.getByTestId('billing-bank-reference-input').fill('T095-BANK-REFERENCE');
      await page.getByTestId('billing-proof-file-input').setInputFiles({
        name: 't095-proof.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 T095 synthetic proof'),
      });
      await page.getByTestId('billing-submit-proof').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('billing-submission-status')).toContainText(
        locale === 'ar' ? ar.billing.status.pendingReview : en.billing.status.pendingReview,
      );
      await runAxe(page);
    }
  } finally {
    await closePair(pair);
  }
});

async function installBillingReviewFixture(page: Page, locale: Locale): Promise<void> {
  const item = {
    ...reviewSubmission,
    planName: locale === 'ar' ? 'النمو' : 'Growth',
  };
  await page.route('**/api/internal/billing/review-queue', (route) =>
    fulfillJson(route, 200, [item]),
  );
}

test('Billing Admin review — EN/AR detail, mirrored queue, keyboard-contained dialog, overflow, and axe', async ({
  browser,
  baseURL,
}) => {
  const pair = await openPair(browser, baseURL!);
  try {
    await seedPairSessions(pair, baseURL!, 'billing-review', true);
    await installBillingReviewFixture(pair.en.page, 'en');
    await installBillingReviewFixture(pair.ar.page, 'ar');
    await Promise.all([pair.en.page.goto('/billing-review'), pair.ar.page.goto('/billing-review')]);
    await Promise.all([
      expect(pair.en.page.getByTestId('billing-review')).toBeVisible(),
      expect(pair.ar.page.getByTestId('billing-review')).toBeVisible(),
    ]);
    await expect(pair.en.page.getByText(en.billingReview.intro, { exact: true })).toBeVisible();
    await expect(pair.ar.page.getByText(ar.billingReview.intro, { exact: true })).toBeVisible();
    await assertSurfacePair(
      pair,
      { en: en.billingReview.title, ar: ar.billingReview.title },
      {
        en: pair.en.page.getByRole('navigation', { name: en.billingReview.queueLabel }),
        ar: pair.ar.page.getByRole('navigation', { name: ar.billingReview.queueLabel }),
      },
    );

    for (const { locale, page } of [
      { locale: 'en' as const, page: pair.en.page },
      { locale: 'ar' as const, page: pair.ar.page },
    ]) {
      const trigger = page.getByRole('button', {
        name: locale === 'ar' ? ar.billingReview.actions.reject : en.billingReview.actions.reject,
      });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const note = page.getByLabel(
        locale === 'ar'
          ? ar.billingReview.dialog.reject.label
          : en.billingReview.dialog.reject.label,
      );
      const cancel = page.getByRole('button', {
        name: locale === 'ar' ? ar.billingReview.actions.cancel : en.billingReview.actions.cancel,
      });
      await expect(note).toBeFocused();
      await note.press('Shift+Tab');
      await expect(cancel).toBeFocused();
      await cancel.press('Tab');
      await expect(note).toBeFocused();
      await runAxe(page);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  } finally {
    await closePair(pair);
  }
});

test('onboarding checklist — EN/AR live items, mirrored cards, keyboard links, overflow, and axe', async ({
  browser,
  baseURL,
}) => {
  const pair = await openPair(browser, baseURL!);
  try {
    await seedPairSessions(pair, baseURL!, 'checklist');
    for (const { page } of [pair.en, pair.ar]) {
      await installChecklistFixture(page);
      await installModulesFixture(page);
      await page.goto('/checklist');
      await expect(page.locator('.kemfai-checklist-item')).toHaveCount(4);
    }
    await expect(
      pair.en.page.getByText(en.onboardingChecklist.intro, { exact: true }),
    ).toBeVisible();
    await expect(
      pair.ar.page.getByText(ar.onboardingChecklist.intro, { exact: true }),
    ).toBeVisible();
    await assertSurfacePair(
      pair,
      { en: en.onboardingChecklist.title, ar: ar.onboardingChecklist.title },
      {
        en: pair.en.page.locator('.kemfai-checklist-item').first(),
        ar: pair.ar.page.locator('.kemfai-checklist-item').first(),
      },
    );
    for (const { locale, page } of [
      { locale: 'en' as const, page: pair.en.page },
      { locale: 'ar' as const, page: pair.ar.page },
    ]) {
      const link = page.getByRole('link', {
        name:
          locale === 'ar'
            ? ar.onboardingChecklist.items.customer.action
            : en.onboardingChecklist.items.customer.action,
      });
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/modules#module\.sales$/);
      await expect(page.locator('[id="module.sales"]')).toHaveAttribute('data-targeted', 'true');
    }
  } finally {
    await closePair(pair);
  }
});

async function seedSupportSSR(page: Page, token: string): Promise<void> {
  const response = await page.request.post(`${STUB_ORIGIN}/__e2e/support-access`, {
    data: { token, grants: [supportGrant] },
  });
  expect(response.status()).toBe(204);
}

async function installSupportFixture(page: Page): Promise<void> {
  let grants: Array<Record<string, unknown>> = [{ ...supportGrant }];
  await page.route('**/api/support-access/grants**', async (route) => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/revoke')) {
      grants = grants.map((grant) => ({
        ...grant,
        status: 'revoked',
        revokedAt: '2026-10-21T10:00:00.000Z',
      }));
      await fulfillJson(route, 200, grants[0]);
      return;
    }
    await fulfillJson(route, 200, grants);
  });
}

test('support grant/history — EN/AR localized role, mirrored form, keyboard revoke, overflow, and axe', async ({
  browser,
  baseURL,
}) => {
  const pair = await openPair(browser, baseURL!);
  try {
    const tokens = await seedPairSessions(pair, baseURL!, 'support-access');
    await Promise.all([
      seedSupportSSR(pair.en.page, tokens.en),
      seedSupportSSR(pair.ar.page, tokens.ar),
    ]);
    for (const { page } of [pair.en, pair.ar]) {
      await installSupportFixture(page);
      await page.goto('/support-access');
      await expect(page.locator('.kemfai-support-grant')).toHaveCount(1);
    }
    await expect(pair.en.page.getByText(en.supportAccess.intro, { exact: true })).toBeVisible();
    await expect(pair.ar.page.getByText(ar.supportAccess.intro, { exact: true })).toBeVisible();
    await expect(pair.ar.page.locator('.kemfai-support-grant')).toContainText('الدعم');
    await expect(pair.ar.page.locator('.kemfai-support-grant')).toContainText(
      ar.supportAccess.usageActions.workspaceSummaryRead,
    );
    await expect(pair.ar.page.locator('.kemfai-support-grant')).toContainText(
      ar.supportAccess.denialReasons.wrong_tenant,
    );
    await expect(pair.ar.page.locator('.kemfai-support-grant')).not.toContainText('Support');
    await expect(pair.ar.page.locator('.kemfai-support-grant')).not.toContainText(
      'workspace.summary.read',
    );
    await expect(pair.ar.page.locator('.kemfai-support-grant')).not.toContainText('wrong_tenant');
    await assertSurfacePair(
      pair,
      { en: en.supportAccess.title, ar: ar.supportAccess.title },
      {
        en: pair.en.page.locator('.kemfai-support-form'),
        ar: pair.ar.page.locator('.kemfai-support-form'),
      },
    );
    for (const { locale, page } of [
      { locale: 'en' as const, page: pair.en.page },
      { locale: 'ar' as const, page: pair.ar.page },
    ]) {
      const revoke = page.getByRole('button', {
        name: locale === 'ar' ? ar.supportAccess.revoke : en.supportAccess.revoke,
      });
      await revoke.focus();
      await page.keyboard.press('Enter');
      await expect(
        page.getByText(
          locale === 'ar' ? ar.supportAccess.status.revoked : en.supportAccess.status.revoked,
          { exact: true },
        ),
      ).toBeVisible();
      await runAxe(page);
    }
  } finally {
    await closePair(pair);
  }
});
