import { expect, test, type Page, type Route } from '@playwright/test';

import ar from '../../src/locales/ar/common.json';
import en from '../../src/locales/en/common.json';
import { openLocalePage, type Locale } from './support/rtl';

test.describe.configure({ timeout: 90_000 });

/**
 * T094 is a frontend-only acceptance sweep. These private, synthetic API responses
 * stimulate the real Next.js pages and controls; they are not live-backend evidence.
 * Requests that prove an in-flight state are held on an explicit promise gate, never
 * a timeout. The support-access stub has one SSR-safe empty GET because page.route
 * cannot intercept the server component's request before hydration.
 */

const moduleOptions = [
  {
    key: 'module.accounting',
    name: 'Accounting',
    nameAr: 'المحاسبة',
    includedInCurrentPlan: true,
    selected: true,
    requiredPlanTier: null,
    requiredPlanTierAr: null,
  },
];

const subscription = {
  status: 'PendingActivation',
  billingPeriodStart: '2026-10-01',
  billingPeriodEnd: '2026-10-31',
  amountDue: 1250,
  currency: 'AED',
  bankInstructions: 'T094 disposable bank instructions',
  paymentReference: 'T094-PRIVATE-PAYMENT-REFERENCE',
};

const reviewSubmission = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'PendingReview',
  submittedAt: '2026-10-16T10:00:00.000Z',
  statusHistory: [{ status: 'PendingReview', changedAt: '2026-10-16T10:00:00.000Z' }],
  customerEmail: 't094-customer@example.test',
  tenantId: '22222222-2222-4222-8222-222222222222',
  planName: 'Growth',
  billingPeriodStart: '2026-10-01',
  billingPeriodEnd: '2026-10-31',
  amount: 250,
  currency: 'AED',
  bankReference: 'T094-BANK-REF',
  proofDownloadUrl: 'https://storage.example.test/t094-proof',
};

const denialReasons = ['expired', 'revoked', 'wrong_tenant', 'action_not_permitted'] as const;

const supportDenialActions = {
  en: {
    expired: 'Create a new grant if support still needs access.',
    revoked: 'Create a new grant if support still needs access.',
    wrong_tenant: 'Use a grant for this workspace.',
    action_not_permitted: 'Review the permitted support scope.',
  },
  ar: {
    expired: 'أنشئ منحة جديدة إذا كان الدعم لا يزال بحاجة إلى الوصول.',
    revoked: 'أنشئ منحة جديدة إذا كان الدعم لا يزال بحاجة إلى الوصول.',
    wrong_tenant: 'استخدم منحة مخصصة لمساحة العمل هذه.',
    action_not_permitted: 'راجع نطاق الدعم المسموح به.',
  },
} as const;

type Messages = typeof en;
type UploadFailure = 'unsupportedType' | 'tooLarge' | 'unreadable';

function messagesFor(locale: Locale): Messages {
  return locale === 'ar' ? ar : en;
}

function deferred() {
  let resolvePromise!: (value: void | PromiseLike<void>) => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise() };
}

function requestGate() {
  const entered = deferred();
  const released = deferred();
  return {
    entered: entered.promise,
    release: released.resolve,
    hold: async () => {
      entered.resolve();
      await released.promise;
    },
  };
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function seedSession(
  page: Page,
  baseURL: string,
  locale: Locale,
  scope: string,
  internal = false,
): Promise<void> {
  const sessionId = `t094-${scope}-${locale}${internal ? '-internal' : ''}`;
  const response = await fetch('http://127.0.0.1:4100/__e2e/seed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      token: `t094-${scope}-${locale}-token`,
      locale,
    }),
  });
  expect(response.status).toBe(204);

  const secureUrl = new URL(baseURL);
  secureUrl.protocol = 'https:';
  await page.context().addCookies([
    {
      name: internal ? '__Host-kemfai_internal_session' : '__Host-kemfai_session',
      value: sessionId,
      url: secureUrl.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

function setupState(currentStep: string, values: Record<string, unknown> = {}, version = 0) {
  return {
    currentStep,
    setupComplete: false,
    values,
    version,
    stale: false,
    scope: 't094-company-scope',
  };
}

function supportGrantsWithDenials() {
  return denialReasons.map((reason, index) => ({
    id: `33333333-3333-4333-8333-33333333333${index}`,
    granteeRole: 'Support',
    grantedBy: '44444444-4444-4444-8444-444444444444',
    grantedAt: '2026-10-19T09:00:00.000Z',
    expiresAt: reason === 'expired' ? '2026-10-20T10:00:00.000Z' : '2026-11-20T12:00:00.000Z',
    revokedAt: reason === 'revoked' ? '2026-10-21T10:30:00.000Z' : null,
    expiredAt: reason === 'expired' ? '2026-10-20T10:00:00.000Z' : null,
    status: reason === 'expired' ? 'expired' : reason === 'revoked' ? 'revoked' : 'active',
    permittedActions: ['workspace.summary.read'],
    usage: [
      {
        id: `55555555-5555-4555-8555-55555555555${index}`,
        usedBy: '66666666-6666-4666-8666-666666666666',
        usedAt:
          reason === 'expired'
            ? '2026-10-20T10:01:00.000Z'
            : reason === 'revoked'
              ? '2026-10-21T10:31:00.000Z'
              : `2026-10-22T10:1${index}:00.000Z`,
        actionSummary: 'workspace.summary.read',
        wasDenied: true,
        denialReason: reason,
      },
    ],
  }));
}

async function choosePaymentFile(page: Page, failure: UploadFailure): Promise<void> {
  const file =
    failure === 'unsupportedType'
      ? {
          name: 't094-proof.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('unsupported proof type'),
        }
      : failure === 'tooLarge'
        ? {
            name: 't094-oversized-proof.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 1),
          }
        : {
            name: 't094-unreadable-proof.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from('not a readable PDF'),
          };
  await page.getByTestId('billing-proof-file-input').setInputFiles(file);
}

for (const locale of ['en', 'ar'] as const) {
  test(`${locale}: provisioning request is visibly loading, then failure is actionable (FR-010/FR-012)`, async ({
    browser,
    baseURL,
  }) => {
    const messages = messagesFor(locale);
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    const gate = requestGate();
    try {
      await seedSession(page, baseURL!, locale, 'provisioning');
      await page.route('**/api/tenants/me', async (route) => {
        await gate.hold();
        // React Strict Mode may abort its first effect request during the
        // development-only mount replay; the next real poll receives the same state.
        await fulfillJson(route, 200, { status: 'Failed' }).catch(() => undefined);
      });

      await page.goto('/provisioning');
      await gate.entered;
      await expect(page.getByTestId('provisioning-loading')).toContainText(
        messages.provisioning.settingUp,
      );
      await expect(page.getByTestId('provisioning-loading')).toContainText(
        messages.provisioning.waiting,
      );

      gate.release();
      const failure = page.getByTestId('provisioning-failure');
      await expect(failure).toContainText(messages.provisioning.failed.title, { timeout: 10_000 });
      await expect(failure).toContainText(messages.provisioning.failed.body);
      await expect(page.getByTestId('provisioning-retry')).toHaveText(messages.provisioning.retry);
      await expect(page.getByTestId('provisioning-support')).toHaveText(
        messages.provisioning.contactSupport,
      );
      await expect(page.getByTestId('provisioning-support')).toHaveAttribute(
        'href',
        /^mailto:support@example\.test\?subject=/,
      );
    } finally {
      gate.release();
      await context.close();
    }
  });

  test(`${locale}: company setup submission, field validation and configuration gap are explicit (FR-010/FR-012)`, async ({
    browser,
    baseURL,
  }) => {
    const messages = messagesFor(locale);
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    const gate = requestGate();
    let putCalls = 0;
    try {
      await seedSession(page, baseURL!, locale, 'setup');
      await page.route('**/api/companies/current/setup', async (route) => {
        if (route.request().method() === 'GET') {
          await fulfillJson(route, 200, setupState('country'));
          return;
        }

        putCalls += 1;
        if (putCalls === 1) {
          await gate.hold();
          await fulfillJson(route, 422, {
            statusCode: 422,
            message: 'country is required',
          });
          return;
        }
        if (putCalls === 2) {
          await fulfillJson(route, 200, setupState('vat_tax', { country: 'AE' }, 1));
          return;
        }
        await fulfillJson(route, 409, {
          statusCode: 409,
          message: 'No VAT/tax validation rule is configured for this country',
        });
      });

      await page.goto('/setup-wizard');
      await expect(page.getByTestId('setup-wizard-step-country')).toHaveAttribute(
        'aria-current',
        'step',
      );
      await page.getByTestId('setup-wizard-next').click();
      await gate.entered;
      await expect(page.getByTestId('setup-wizard-submitting')).toHaveText(
        messages.setupWizard.actions.saving,
      );
      await expect(page.getByTestId('setup-wizard-next')).toHaveText(
        messages.setupWizard.actions.saving,
      );
      await expect(page.getByTestId('setup-wizard-next')).toBeDisabled();

      gate.release();
      await expect(page.getByTestId('setup-wizard-field-error')).toHaveText(
        messages.setupWizard.fields.country.error,
      );
      await expect(page.getByLabel(messages.setupWizard.fields.country.label)).toHaveAttribute(
        'aria-invalid',
        'true',
      );

      await page.getByLabel(messages.setupWizard.fields.country.label).fill('AE');
      await page.getByTestId('setup-wizard-next').click();
      await expect(page.getByTestId('setup-wizard-step-identity')).toHaveAttribute(
        'aria-current',
        'step',
      );
      await page.getByTestId('setup-wizard-step-vat_tax').click();
      await page.getByLabel(messages.setupWizard.fields.vat_tax_registration.label).fill('TRN-1');
      await page.getByTestId('setup-wizard-next').click();
      await expect(page.getByTestId('setup-wizard-config-gap')).toHaveText(
        messages.setupWizard.errors.configGap,
      );
      await expect(page.getByTestId('setup-wizard-next')).toBeEnabled();
      expect(putCalls).toBe(3);
    } finally {
      gate.release();
      await context.close();
    }
  });

  test(`${locale}: module save is visibly in flight and an empty catalog renders its empty state (FR-010/FR-011)`, async ({
    browser,
    baseURL,
  }) => {
    const messages = messagesFor(locale);
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    const gate = requestGate();
    let emptyCatalog = false;
    try {
      await seedSession(page, baseURL!, locale, 'modules');
      await page.route('**/api/modules', (route) =>
        fulfillJson(route, 200, emptyCatalog ? [] : moduleOptions),
      );
      await page.route('**/api/modules/selection', async (route) => {
        await gate.hold();
        await fulfillJson(route, 200, { featureKeys: ['module.accounting'] });
      });

      await page.goto('/modules');
      await expect(
        page.getByRole('heading', { name: messages.moduleSelection.title }),
      ).toBeVisible();
      await page.getByTestId('module-selection-save').click();
      await gate.entered;
      await expect(page.getByTestId('module-selection-save')).toHaveText(
        messages.moduleSelection.saving,
      );
      await expect(page.getByTestId('module-selection-save')).toBeDisabled();

      gate.release();
      await expect(page.getByTestId('module-selection-success')).toContainText(
        messages.moduleSelection.saved,
      );

      emptyCatalog = true;
      await page.reload();
      await expect(page.getByText(messages.moduleSelection.empty, { exact: true })).toBeVisible();
      await expect(page.locator('[id="select-module.accounting"]')).toHaveCount(0);
    } finally {
      gate.release();
      await context.close();
    }
  });

  test(`${locale}: payment submission loading and all upload failures are distinct and actionable (FR-010/FR-012)`, async ({
    browser,
    baseURL,
  }) => {
    const messages = messagesFor(locale);
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    const gate = requestGate();
    let failure: UploadFailure = 'unsupportedType';
    const codes: Record<UploadFailure, string> = {
      unsupportedType: 'PAYMENT_PROOF_UNSUPPORTED_TYPE',
      tooLarge: 'PAYMENT_PROOF_TOO_LARGE',
      unreadable: 'PAYMENT_PROOF_UNREADABLE',
    };
    try {
      await seedSession(page, baseURL!, locale, 'billing');
      await page.route('**/api/billing/subscription', (route) =>
        fulfillJson(route, 200, subscription),
      );
      await page.route('**/api/billing/payment-submissions', async (route) => {
        if (route.request().method() === 'GET') {
          await fulfillJson(route, 200, []);
          return;
        }
        const currentFailure = failure;
        if (currentFailure === 'unsupportedType') await gate.hold();
        await fulfillJson(route, 422, {
          statusCode: 422,
          code: codes[currentFailure],
          message: 'Synthetic T094 upload rejection',
        });
      });

      await page.goto('/billing');
      await page.getByTestId('billing-bank-reference-input').fill('T094-BANK-REF');
      await choosePaymentFile(page, failure);
      await page.getByTestId('billing-submit-proof').click();
      await gate.entered;
      await expect(page.getByTestId('billing-submit-proof')).toHaveText(
        messages.billing.form.submitting,
      );
      await expect(page.getByTestId('billing-submit-proof')).toBeDisabled();
      await expect(
        page.getByRole('status').filter({ hasText: messages.billing.form.submitting }),
      ).toBeVisible();

      gate.release();
      await expect(page.getByTestId('billing-upload-error')).toHaveText(
        messages.billing.errors.unsupportedType,
      );

      for (const nextFailure of ['tooLarge', 'unreadable'] as const) {
        failure = nextFailure;
        await choosePaymentFile(page, nextFailure);
        await page.getByTestId('billing-submit-proof').click();
        await expect(page.getByTestId('billing-upload-error')).toHaveText(
          messages.billing.errors[nextFailure],
        );
        await expect(page.getByTestId('billing-submit-proof')).toHaveText(
          messages.billing.form.submit,
        );
      }
    } finally {
      gate.release();
      await context.close();
    }
  });

  test(`${locale}: Billing Admin decision is visibly in progress until its request settles (FR-010)`, async ({
    browser,
    baseURL,
  }) => {
    const messages = messagesFor(locale);
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    const gate = requestGate();
    let decided = false;
    try {
      await seedSession(page, baseURL!, locale, 'billing-review', true);
      await page.route('**/api/internal/billing/review-queue', (route) =>
        fulfillJson(route, 200, decided ? [] : [reviewSubmission]),
      );
      await page.route('**/api/internal/billing/payment-submissions/**', async (route) => {
        await gate.hold();
        decided = true;
        await fulfillJson(route, 200, {
          submissionId: reviewSubmission.id,
          subscriptionId: '77777777-7777-4777-8777-777777777777',
          status: 'Active',
          billingPeriodStart: reviewSubmission.billingPeriodStart,
          billingPeriodEnd: reviewSubmission.billingPeriodEnd,
          activatedAt: '2026-10-24T12:00:00.000Z',
        });
      });

      await page.goto('/billing-review');
      await page.getByRole('button', { name: messages.billingReview.actions.approve }).click();
      await page.getByRole('button', { name: messages.billingReview.actions.confirm }).click();
      await gate.entered;
      const deciding = page.getByRole('button', {
        name: messages.billingReview.actions.deciding,
      });
      await expect(deciding).toBeVisible();
      await expect(deciding).toBeDisabled();
      await expect(page.getByRole('dialog')).toBeVisible();

      gate.release();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('status')).toHaveText(messages.billingReview.messages.approved);
    } finally {
      gate.release();
      await context.close();
    }
  });

  test(`${locale}: checklist and support history empty states render; support denials are localized and actionable (FR-011/FR-012)`, async ({
    browser,
    baseURL,
  }) => {
    const messages = messagesFor(locale);
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    let supportRows: unknown[] = [];
    try {
      await seedSession(page, baseURL!, locale, 'empty-surfaces');
      // The checklist's initial read is performed by the server component. The
      // existing private stub returns all four readiness signals false.
      await page.goto('/checklist');
      await expect(page.getByTestId('checklist-empty')).toContainText(
        messages.onboardingChecklist.empty,
      );
      await expect(page.locator('.kemfai-checklist-item')).toHaveCount(4);

      await page.route('**/api/support-access/grants', (route) =>
        fulfillJson(route, 200, supportRows),
      );
      await page.goto('/support-access');
      await expect(page.getByTestId('support-access-empty')).toContainText(
        messages.supportAccess.empty,
      );

      supportRows = supportGrantsWithDenials();
      await page.getByRole('button', { name: messages.supportAccess.refresh }).click();
      await expect(page.getByTestId('support-access-empty')).toHaveCount(0);
      const grantTiles = page.locator('.kemfai-support-grant');
      for (const [index, reason] of denialReasons.entries()) {
        const grantTile = grantTiles.nth(index);
        await expect(
          grantTile.getByText(messages.supportAccess.denialReasons[reason], { exact: false }),
        ).toBeVisible();
        await expect(
          grantTile.getByText(supportDenialActions[locale][reason], { exact: true }),
        ).toBeVisible();
      }
      const history = page.locator('.kemfai-support-history');
      await expect(history).not.toContainText('wrong_tenant');
      await expect(history).not.toContainText('action_not_permitted');
    } finally {
      await context.close();
    }
  });

  test(`${locale}: plan empty state plus malformed email, weak password and duplicate signup failures render (FR-011/FR-012)`, async ({
    browser,
    baseURL,
  }) => {
    const messages = messagesFor(locale);
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    const received: string[] = [];
    try {
      await page.route('**/public/plans', (route) => fulfillJson(route, 200, []));
      await page.goto('/plans');
      await expect(page.getByText(messages.plans.empty, { exact: true })).toBeVisible();
      await expect(page.getByTestId('plan-card')).toHaveCount(0);

      await page.route('**/accounts/signup', async (route) => {
        const body = route.request().postDataJSON() as { email: string; password: string };
        if (body.email === 'malformed') {
          received.push('malformedEmail');
          await fulfillJson(route, 422, { statusCode: 422, message: ['email must be an email'] });
          return;
        }
        if (body.password === 'short') {
          received.push('weakPassword');
          await fulfillJson(route, 422, {
            statusCode: 422,
            message: ['password must be longer than or equal to 10 characters'],
          });
          return;
        }
        received.push('duplicateEmail');
        await fulfillJson(route, 409, {
          statusCode: 409,
          message: 'An account already exists',
        });
      });

      await page.goto('/signup?plan=77777777-7777-4777-8777-777777777777&cycle=monthly');
      const email = page.getByLabel(messages.signup.emailLabel);
      const password = page.getByLabel(messages.signup.passwordLabel);
      const signupAlert = page.locator('form [role="alert"]:not(#__next-route-announcer__)');
      await page.getByLabel(messages.signup.acceptedTermsLabel).check();

      await email.fill('malformed');
      await password.fill('strong-password');
      await page.getByTestId('signup-submit-button').click();
      await expect(signupAlert).toHaveText(messages.signup.errors.malformedEmail);

      await email.fill('weak@example.test');
      await password.fill('short');
      await page.getByTestId('signup-submit-button').click();
      await expect(signupAlert).toHaveText(messages.signup.errors.weakPassword);

      await email.fill('duplicate@example.test');
      await password.fill('strong-password');
      await page.getByTestId('signup-submit-button').click();
      const duplicate = signupAlert;
      await expect(duplicate).toContainText(messages.signup.duplicateEmail.message);
      await expect(
        duplicate.getByRole('link', { name: messages.signup.duplicateEmail.signIn }),
      ).toHaveAttribute('href', '/login');
      await expect(
        duplicate.getByRole('link', { name: messages.signup.duplicateEmail.resetPassword }),
      ).toHaveAttribute('href', '/reset-password');
      expect(received).toEqual(['malformedEmail', 'weakPassword', 'duplicateEmail']);
    } finally {
      await context.close();
    }
  });

  test(`${locale}: expired, invalid and reused verification links each render recovery action (FR-012)`, async ({
    browser,
    baseURL,
  }) => {
    const messages = messagesFor(locale);
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    const requestedTokens = new Set<string>();
    try {
      await page.route('**/accounts/verify-email', async (route) => {
        const body = route.request().postDataJSON() as { token: string };
        requestedTokens.add(body.token);
        const reason = body.token === 'reused' ? 'used' : body.token;
        await fulfillJson(route, 410, {
          statusCode: 410,
          reason,
          message: `This verification link is ${reason}. Please request a new one.`,
        });
      });

      for (const failure of ['expired', 'invalid', 'reused'] as const) {
        await page.goto(`/verify?token=${failure}`);
        const reason = failure === 'reused' ? 'used' : failure;
        const state = page.getByTestId('verify-invalid-message');
        await expect(state).toHaveAttribute('data-verification-error', reason);
        await expect(state.locator('h1')).toHaveText(messages.verifyEmail[reason].title);
        await expect(state.locator('p')).toHaveText(messages.verifyEmail[reason].body);
        await expect(page.getByTestId('verify-resend-button')).toHaveText(
          messages.verifyEmail.resend.submit,
        );
        await expect(page.getByLabel(messages.verifyEmail.resend.emailLabel)).toBeVisible();
      }
      expect([...requestedTokens]).toEqual(['expired', 'invalid', 'reused']);
    } finally {
      await context.close();
    }
  });
}
