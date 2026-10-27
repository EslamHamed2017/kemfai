import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

import ar from '../../src/locales/ar/common.json';
import en from '../../src/locales/en/common.json';
import { openLocalePage, type Locale } from './support/rtl';

/**
 * T110 — FR-012/FR-015 are not covered by an axe pass. This suite removes
 * semantic colour, background, border, and shadow cues, then reads the text on
 * each real status/error indicator rendered by the application.
 */

const NEUTRAL_COLOUR_CUES = `
  *, *::before, *::after {
    color: rgb(17, 17, 17) !important;
    background-color: rgb(255, 255, 255) !important;
    background-image: none !important;
    border-color: rgb(102, 102, 102) !important;
    box-shadow: none !important;
    text-shadow: none !important;
  }
`;

const requiredCopy = {
  en: {
    provisioning: {
      Pending: 'Workspace setup is pending',
      Creating: 'Workspace setup is in progress',
    },
    verification: {
      invalid: {
        title: 'This verification link is invalid',
        body: 'This link is missing or has been replaced by a newer link. Request a new one below.',
      },
      expired: {
        title: 'This verification link has expired',
        body: 'Request a new verification link below to continue.',
      },
      used: {
        title: 'This verification link has already been used',
        body: 'If your email still needs verification, request a new link below.',
      },
    },
    deniedSupportAttempt: 'Denied: the request targeted a different workspace.',
  },
  ar: {
    provisioning: {
      Pending: 'إعداد مساحة العمل قيد الانتظار',
      Creating: 'إعداد مساحة العمل قيد التنفيذ',
    },
    verification: {
      invalid: {
        title: 'رابط التحقق غير صالح',
        body: 'هذا الرابط مفقود أو استُبدل برابط أحدث. اطلب رابطًا جديدًا أدناه.',
      },
      expired: {
        title: 'انتهت صلاحية رابط التحقق',
        body: 'اطلب رابط تحقق جديدًا أدناه للمتابعة.',
      },
      used: {
        title: 'تم استخدام رابط التحقق من قبل',
        body: 'إذا كان بريدك الإلكتروني لا يزال بحاجة إلى التحقق، فاطلب رابطًا جديدًا أدناه.',
      },
    },
    deniedSupportAttempt: 'مرفوض: استهدف الطلب مساحة عمل مختلفة.',
  },
} as const;

async function neutralizeColourCues(page: Page): Promise<void> {
  await page.addStyleTag({ content: NEUTRAL_COLOUR_CUES });
}

async function expectIndependentText(
  locator: Locator,
  expected: string,
  exact = false,
): Promise<void> {
  await expect(locator).toBeVisible();
  if (exact) await expect(locator).toHaveText(expected);
  else await expect(locator).toContainText(expected);

  const evidence = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      text: (element as HTMLElement).innerText.trim(),
      color: style.color,
      backgroundColor: style.backgroundColor,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
    };
  });
  expect(evidence.text.length).toBeGreaterThan(0);
  expect(evidence.color).toBe('rgb(17, 17, 17)');
  expect(evidence.backgroundColor).toBe('rgb(255, 255, 255)');
  expect(evidence.display).not.toBe('none');
  expect(evidence.visibility).toBe('visible');
  expect(Number(evidence.opacity)).toBeGreaterThan(0);
  expect(await locator.boundingBox()).not.toBeNull();
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

let sessionSequence = 0;

async function authenticateCustomer(
  page: Page,
  baseURL: string,
  locale: Locale,
  prefix: string,
): Promise<void> {
  sessionSequence += 1;
  const sessionId = `t110-${prefix}-${locale}-${sessionSequence}`;
  const response = await fetch('http://127.0.0.1:4100/__e2e/seed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, token: `${sessionId}-token`, locale }),
  });
  expect(response.status).toBe(204);
  const secureUrl = new URL(baseURL);
  secureUrl.protocol = 'https:';
  await page.context().addCookies([
    {
      name: '__Host-kemfai_session',
      value: sessionId,
      url: secureUrl.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

async function authenticateBillingAdmin(
  page: Page,
  baseURL: string,
  locale: Locale,
): Promise<void> {
  sessionSequence += 1;
  const sessionId = `t110-billing-admin-${locale}-${sessionSequence}`;
  const response = await fetch('http://127.0.0.1:4100/__e2e/seed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, token: `${sessionId}-token`, locale }),
  });
  expect(response.status).toBe(204);
  const secureUrl = new URL(baseURL);
  secureUrl.protocol = 'https:';
  await page.context().addCookies([
    {
      name: '__Host-kemfai_internal_session',
      value: sessionId,
      url: secureUrl.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

const subscription = {
  status: 'PendingActivation',
  billingPeriodStart: '2026-10-01',
  billingPeriodEnd: '2026-10-31',
  amountDue: 250,
  currency: 'AED',
  bankInstructions: 'T110 private-fixture bank instructions',
  paymentReference: 'T110-REFERENCE',
};

type BillingStatus = 'PendingReview' | 'Approved' | 'Rejected' | 'MoreInfoRequested';

const billingStatusKeys = {
  PendingReview: 'pendingReview',
  Approved: 'approved',
  Rejected: 'rejected',
  MoreInfoRequested: 'moreInfoRequested',
} as const;

function paymentSubmission(status: BillingStatus) {
  return {
    id: '11000000-0000-4000-8000-000000000110',
    status,
    submittedAt: '2026-10-24T12:00:00.000Z',
    statusHistory: [{ status, changedAt: '2026-10-24T12:00:00.000Z' }],
  };
}

for (const locale of ['en', 'ar'] as const) {
  test(`${locale} billing lifecycle labels survive neutral colour cues on customer status`, async ({
    browser,
    baseURL,
  }) => {
    const messages = locale === 'ar' ? ar : en;
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      await authenticateCustomer(page, baseURL!, locale, 'billing');
      let currentStatus: BillingStatus = 'PendingReview';
      await page.route('**/api/billing/subscription', (route) =>
        fulfillJson(route, 200, subscription),
      );
      await page.route('**/api/billing/payment-submissions', (route) =>
        fulfillJson(route, 200, [paymentSubmission(currentStatus)]),
      );

      for (const status of Object.keys(billingStatusKeys) as BillingStatus[]) {
        currentStatus = status;
        await page.goto('/billing');
        const indicator = page.getByTestId('billing-submission-status');
        const expected = messages.billing.status[billingStatusKeys[status]];
        await expect(indicator).toHaveText(expected);
        await neutralizeColourCues(page);
        await expectIndependentText(indicator, expected, true);
      }
    } finally {
      await context.close();
    }
  });

  test(`${locale} billing lifecycle labels survive neutral colour cues in review history`, async ({
    browser,
    baseURL,
  }) => {
    const messages = locale === 'ar' ? ar : en;
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      await authenticateBillingAdmin(page, baseURL!, locale);

      const history = (Object.keys(billingStatusKeys) as BillingStatus[]).map((status) => ({
        status,
        changedAt: '2026-10-24T12:00:00.000Z',
      }));
      await page.route('**/api/internal/billing/review-queue', (route) =>
        fulfillJson(route, 200, [
          {
            ...paymentSubmission('PendingReview'),
            customerEmail: 'customer@example.test',
            tenantId: '22000000-0000-4000-8000-000000000110',
            planName: 'Growth',
            billingPeriodStart: subscription.billingPeriodStart,
            billingPeriodEnd: subscription.billingPeriodEnd,
            amount: subscription.amountDue,
            currency: subscription.currency,
            bankReference: 'T110-BANK-REFERENCE',
            proofDownloadUrl: 'https://storage.example.test/t110-proof',
            statusHistory: history,
          },
        ]),
      );
      await page.goto('/billing-review');
      const historyList = page
        .getByRole('heading', { name: messages.billingReview.history })
        .locator('..');
      await expect(historyList.locator('li')).toHaveCount(4);
      await neutralizeColourCues(page);
      for (const [index, status] of (Object.keys(billingStatusKeys) as BillingStatus[]).entries()) {
        await expectIndependentText(
          historyList.locator('li').nth(index).locator('span'),
          messages.billingReview.status[status],
          true,
        );
      }
    } finally {
      await context.close();
    }
  });
}

const supportGrants = [
  {
    id: '11000000-0000-4000-8000-000000000001',
    granteeRole: 'Support',
    grantedBy: 'owner-1',
    grantedAt: '2026-10-24T09:00:00.000Z',
    expiresAt: '2026-10-25T09:00:00.000Z',
    revokedAt: null,
    expiredAt: null,
    status: 'active',
    permittedActions: ['workspace.summary.read'],
    usage: [
      {
        id: 'usage-1',
        usedBy: 'support-1',
        usedAt: '2026-10-24T10:00:00.000Z',
        actionSummary: 'workspace.summary.read',
        wasDenied: true,
        denialReason: 'wrong_tenant',
      },
    ],
  },
  {
    id: '11000000-0000-4000-8000-000000000002',
    granteeRole: 'Support',
    grantedBy: 'owner-1',
    grantedAt: '2026-10-20T09:00:00.000Z',
    expiresAt: '2026-10-21T09:00:00.000Z',
    revokedAt: null,
    expiredAt: '2026-10-21T09:00:00.000Z',
    status: 'expired',
    permittedActions: ['workspace.summary.read'],
    usage: [],
  },
  {
    id: '11000000-0000-4000-8000-000000000003',
    granteeRole: 'Support',
    grantedBy: 'owner-1',
    grantedAt: '2026-10-22T09:00:00.000Z',
    expiresAt: '2026-10-25T09:00:00.000Z',
    revokedAt: '2026-10-23T09:00:00.000Z',
    expiredAt: null,
    status: 'revoked',
    permittedActions: ['workspace.summary.read'],
    usage: [],
  },
];

for (const locale of ['en', 'ar'] as const) {
  test(`${locale} support active, expired, revoked, and denied-attempt labels survive neutral colour cues`, async ({
    browser,
    baseURL,
  }) => {
    const messages = locale === 'ar' ? ar : en;
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      await authenticateCustomer(page, baseURL!, locale, 'support');
      const seed = await fetch('http://127.0.0.1:4100/__e2e/support-grants', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grants: supportGrants }),
      });
      expect(seed.status).toBe(204);
      await page.goto('/support-access');
      const tiles = page.locator('.kemfai-support-grant');
      await expect(tiles).toHaveCount(3);
      await neutralizeColourCues(page);

      for (const [index, status] of (['active', 'expired', 'revoked'] as const).entries()) {
        await expectIndependentText(
          tiles.nth(index).locator('.cds--tag').first(),
          messages.supportAccess.status[status],
          true,
        );
      }
      const denied = tiles
        .first()
        .getByText(requiredCopy[locale].deniedSupportAttempt, { exact: true });
      await expectIndependentText(denied, requiredCopy[locale].deniedSupportAttempt, true);
      await expect(tiles.first()).not.toContainText('wrong_tenant');
    } finally {
      await context.close();
    }
  });
}

for (const locale of ['en', 'ar'] as const) {
  test(`${locale} provisioning Pending, Creating, Ready, and Failed labels survive neutral colour cues`, async ({
    browser,
    baseURL,
  }) => {
    const messages = locale === 'ar' ? ar : en;
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      await authenticateCustomer(page, baseURL!, locale, 'provisioning');
      let currentStatus: 'Pending' | 'Creating' | 'Ready' | 'Failed' = 'Pending';
      await page.route('**/api/tenants/me', (route) =>
        fulfillJson(route, 200, { status: currentStatus }),
      );
      const expected = {
        Pending: requiredCopy[locale].provisioning.Pending,
        Creating: requiredCopy[locale].provisioning.Creating,
        Ready: messages.provisioning.ready.title,
        Failed: messages.provisioning.failed.title,
      } as const;

      for (const status of ['Pending', 'Creating', 'Ready', 'Failed'] as const) {
        currentStatus = status;
        await page.goto('/provisioning');
        const indicator = page.getByTestId('provisioning-status');
        await expect(indicator).toHaveText(expected[status]);
        await neutralizeColourCues(page);
        await expectIndependentText(indicator, expected[status], true);
      }
    } finally {
      await context.close();
    }
  });
}

type SignupFailure = 'malformed' | 'weak' | 'duplicate';

for (const locale of ['en', 'ar'] as const) {
  test(`${locale} malformed-email, weak-password, and duplicate-email labels survive neutral colour cues`, async ({
    browser,
    baseURL,
  }) => {
    const messages = locale === 'ar' ? ar : en;
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      let failure: SignupFailure = 'malformed';
      await page.route('**/accounts/signup', (route) => {
        if (failure === 'duplicate') {
          return fulfillJson(route, 409, { statusCode: 409, message: 'duplicate' });
        }
        return fulfillJson(route, 422, {
          statusCode: 422,
          message:
            failure === 'malformed'
              ? ['email must be a well-formed email address']
              : ['password must be at least 10 characters'],
        });
      });
      const cases = [
        ['malformed', messages.signup.errors.malformedEmail],
        ['weak', messages.signup.errors.weakPassword],
        ['duplicate', messages.signup.duplicateEmail.message],
      ] as const;
      const rendered: string[] = [];

      for (const [kind, expected] of cases) {
        failure = kind;
        await page.goto('/signup?plan=11000000-0000-4000-8000-000000000110&cycle=monthly');
        await page.getByLabel(messages.signup.emailLabel).fill('owner@example.test');
        await page.getByLabel(messages.signup.passwordLabel).fill('a-strong-password');
        await page.getByLabel(messages.signup.acceptedTermsLabel).check();
        await page.getByTestId('signup-submit-button').click();
        const indicator = page.locator('[role="alert"]:not(#__next-route-announcer__)');
        await expect(indicator).toContainText(expected);
        await neutralizeColourCues(page);
        await expectIndependentText(indicator, expected);
        rendered.push((await indicator.innerText()).trim());
      }
      expect(new Set(rendered).size).toBe(3);
    } finally {
      await context.close();
    }
  });
}

type VerificationFailure = 'invalid' | 'expired' | 'used';

for (const locale of ['en', 'ar'] as const) {
  test(`${locale} invalid, expired, and reused verification-link labels survive neutral colour cues`, async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      let failure: VerificationFailure = 'invalid';
      await page.route('**/accounts/verify-email', (route) =>
        fulfillJson(route, 410, {
          statusCode: 410,
          reason: failure,
          message: `T110 ${failure} verification fixture`,
        }),
      );
      const renderedTitles: string[] = [];

      for (const reason of ['invalid', 'expired', 'used'] as const) {
        failure = reason;
        await page.goto(`/verify?token=t110-${reason}`);
        const indicator = page.getByTestId('verify-invalid-message');
        const title = indicator.locator('h1');
        const body = indicator.locator('p');
        await expect(title).toHaveText(requiredCopy[locale].verification[reason].title);
        await expect(body).toHaveText(requiredCopy[locale].verification[reason].body);
        await neutralizeColourCues(page);
        await expectIndependentText(title, requiredCopy[locale].verification[reason].title, true);
        await expectIndependentText(body, requiredCopy[locale].verification[reason].body, true);
        renderedTitles.push((await title.innerText()).trim());
      }
      expect(new Set(renderedTitles).size).toBe(3);
    } finally {
      await context.close();
    }
  });
}

for (const locale of ['en', 'ar'] as const) {
  test(`${locale} setup validation and configuration-gap labels survive neutral colour cues`, async ({
    browser,
    baseURL,
  }) => {
    const messages = locale === 'ar' ? ar : en;
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      await authenticateCustomer(page, baseURL!, locale, 'wizard');
      const countryState = {
        currentStep: 'country',
        setupComplete: false,
        values: {},
        version: 0,
        stale: false,
        scope: `t110-${locale}-scope`,
      };
      await page.route('**/api/companies/current/setup', async (route) => {
        if (route.request().method() === 'GET') {
          await fulfillJson(route, 200, countryState);
          return;
        }
        const body = route.request().postDataJSON() as {
          step: string;
          values: Record<string, unknown>;
        };
        if (body.step === 'country' && !String(body.values.country ?? '').trim()) {
          await fulfillJson(route, 422, {
            statusCode: 422,
            message: 'country is required.',
          });
          return;
        }
        if (body.step === 'vat_tax') {
          await fulfillJson(route, 409, {
            statusCode: 409,
            message: 'No VAT/tax validation rule is configured for this country',
          });
          return;
        }
        await fulfillJson(route, 200, {
          ...countryState,
          currentStep: 'vat_tax',
          values: { country: 'AE' },
          version: 1,
        });
      });

      await page.goto('/setup-wizard');
      await page.getByTestId('setup-wizard-next').click();
      const validation = page.getByTestId('setup-wizard-field-error');
      await expect(validation).toHaveText(messages.setupWizard.fields.country.error);
      await neutralizeColourCues(page);
      await expectIndependentText(validation, messages.setupWizard.fields.country.error, true);
      const validationText = (await validation.innerText()).trim();

      await page.getByLabel(messages.setupWizard.fields.country.label).fill('AE');
      await page.getByTestId('setup-wizard-next').click();
      const vatStep = page.getByTestId('setup-wizard-step-vat_tax');
      await expect(vatStep).toBeEnabled();
      await vatStep.click();
      await page
        .getByLabel(messages.setupWizard.fields.vat_tax_registration.label)
        .fill('T110-TRN');
      await page.getByTestId('setup-wizard-next').click();
      const configGap = page.getByTestId('setup-wizard-config-gap');
      await expectIndependentText(configGap, messages.setupWizard.errors.configGap, true);
      expect((await configGap.innerText()).trim()).not.toBe(validationText);
    } finally {
      await context.close();
    }
  });
}

const uploadFailures = {
  unsupportedType: 'PAYMENT_PROOF_UNSUPPORTED_TYPE',
  tooLarge: 'PAYMENT_PROOF_TOO_LARGE',
  unreadable: 'PAYMENT_PROOF_UNREADABLE',
} as const;

for (const locale of ['en', 'ar'] as const) {
  test(`${locale} unsupported-type, oversize, and unreadable proof labels survive neutral colour cues`, async ({
    browser,
    baseURL,
  }) => {
    const messages = locale === 'ar' ? ar : en;
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      await authenticateCustomer(page, baseURL!, locale, 'upload');
      let failure: keyof typeof uploadFailures = 'unsupportedType';
      await page.route('**/api/billing/subscription', (route) =>
        fulfillJson(route, 200, subscription),
      );
      await page.route('**/api/billing/payment-submissions', (route) => {
        if (route.request().method() === 'GET') return fulfillJson(route, 200, []);
        return fulfillJson(route, 422, {
          statusCode: 422,
          code: uploadFailures[failure],
          message: 'T110 backend fixture text must not be rendered',
        });
      });
      const rendered: string[] = [];

      for (const kind of Object.keys(uploadFailures) as Array<keyof typeof uploadFailures>) {
        failure = kind;
        await page.goto('/billing');
        await page.getByTestId('billing-bank-reference-input').fill('T110-BANK');
        await page.getByTestId('billing-proof-file-input').setInputFiles({
          name: 't110-proof.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4 T110 disposable proof fixture'),
        });
        await page.getByTestId('billing-submit-proof').click();
        const indicator = page.getByTestId('billing-upload-error');
        const expected = messages.billing.errors[kind];
        await expect(indicator).toHaveText(expected);
        await neutralizeColourCues(page);
        await expectIndependentText(indicator, expected, true);
        rendered.push((await indicator.innerText()).trim());
      }
      expect(new Set(rendered).size).toBe(3);
    } finally {
      await context.close();
    }
  });
}

for (const locale of ['en', 'ar'] as const) {
  test(`${locale} module blocked and upgrade-required labels survive neutral colour cues`, async ({
    browser,
    baseURL,
  }) => {
    const messages = locale === 'ar' ? ar : en;
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      await authenticateCustomer(page, baseURL!, locale, 'modules');
      const options = [
        {
          key: 'module.accounting',
          name: 'Accounting',
          nameAr: 'المحاسبة',
          includedInCurrentPlan: true,
          selected: false,
          requiredPlanTier: 'Growth',
          requiredPlanTierAr: 'النمو',
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
      await page.route('**/api/modules', (route) => fulfillJson(route, 200, options));
      await page.route('**/api/modules/selection', (route) =>
        fulfillJson(route, 422, { featureKeys: ['module.accounting'] }),
      );

      await page.goto('/modules');
      const project = page.locator('[id="module.projects"]');
      await expect(project).toBeVisible();
      await expect(page.getByLabel(locale === 'ar' ? 'المحاسبة' : 'Accounting')).not.toBeChecked();
      await page.locator('label[for="select-module.accounting"]').click();
      await page.getByTestId('module-selection-save').click();
      const plan = locale === 'ar' ? 'النمو' : 'Growth';
      const blockedText = messages.moduleSelection.blocked.replace('{plan}', plan);
      const blocked = page.locator('.cds--inline-notification').filter({ hasText: blockedText });
      await expect(blocked).toBeVisible();
      await neutralizeColourCues(page);
      await expectIndependentText(
        project.locator('.cds--tag').first(),
        messages.moduleSelection.upgradeRequired,
        true,
      );
      await expectIndependentText(
        page.getByTestId('module-module.projects-upgrade'),
        messages.moduleSelection.requiredPlan.replace('{plan}', plan),
        true,
      );
      await expectIndependentText(blocked, blockedText);
    } finally {
      await context.close();
    }
  });
}

for (const locale of ['en', 'ar'] as const) {
  test(`${locale} activation gate remains a distinct text label when setup readiness is complete`, async ({
    browser,
    baseURL,
  }) => {
    const messages = locale === 'ar' ? ar : en;
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      await authenticateCustomer(page, baseURL!, locale, 'checklist');
      await page.route('**/api/onboarding/checklist', (route) =>
        fulfillJson(route, 200, {
          customerAdded: true,
          bankAdded: true,
          productAdded: true,
          firstInvoiceReady: true,
          gatedOnSubscriptionActivation: true,
        }),
      );
      await page.goto('/checklist');
      const gate = page.getByTestId('activation-gate');
      const readiness = page.getByTestId('checklist-firstInvoice').locator('.cds--tag').first();
      await expect(readiness).toHaveText(messages.onboardingChecklist.complete);
      await neutralizeColourCues(page);
      await expectIndependentText(gate, messages.onboardingChecklist.activationGate);
      await expectIndependentText(gate, messages.onboardingChecklist.activationHelp);
      await expectIndependentText(readiness, messages.onboardingChecklist.complete, true);

      const gateText = (await gate.innerText()).trim();
      const readinessText = (await readiness.innerText()).trim();
      expect(gateText).not.toContain(readinessText);
      expect(readinessText).not.toContain(messages.onboardingChecklist.activationGate);
    } finally {
      await context.close();
    }
  });
}
