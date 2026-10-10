import { expect, test, type Page, type Route } from '@playwright/test';

import {
  VIEWPORT,
  assertDirectionalIcons,
  assertMirrored,
  assertNoHorizontalOverflow,
  openLocalePage,
  runAxe,
  type Locale,
} from './support/rtl';

/**
 * T060 — test-first Playwright specification for US5 Acceptance Scenarios 5.1–5.3
 * and FR-012. T061–T063 intentionally do not exist yet, so these tests must remain
 * RED against the repository until those tasks provide the real billing surface.
 *
 * The API responses below are explicitly synthetic, T060-owned browser fixtures.
 * They exercise the future UI contract only and are not live-backend evidence.
 */

const subscription = {
  status: 'PendingActivation',
  billingPeriodStart: '2026-10-01',
  billingPeriodEnd: '2026-10-31',
  amountDue: 1250,
  currency: 'AED',
  paymentReference: 'T060-PRIVATE-PAYMENT-REFERENCE',
} as const;

const bankReference = 'T060-PRIVATE-BANK-REFERENCE';
const proofContents = Buffer.from('%PDF-1.4 T060 disposable private proof fixture');

const copy = {
  en: {
    title: 'Billing and payment',
    bankInstructions: 'Bank transfer instructions',
    bankInstructionsBody: 'Transfer to the T060 private-fixture KEMFAI account.',
    paymentReference: 'Payment reference',
    amountDue: 'Amount due',
    amountNumerals: '1,250',
    billingPeriod: 'Billing period',
    billingPeriodStart: 'Oct 1, 2026',
    billingPeriodEnd: 'Oct 31, 2026',
    submissionDate: 'Oct 10, 2026',
    bankReferenceInput: 'Bank transfer reference',
    proofFileInput: 'Payment proof',
    submit: 'Submit payment proof',
    pendingReview: 'Pending review',
    duplicateBlock: 'A payment submission is already under review for this billing period.',
    unsupportedProofType:
      'This proof file type is not supported. Choose a PDF, PNG, or JPEG file and try again.',
    oversizedProof:
      'This proof file is too large. Choose a PDF, PNG, or JPEG file within the upload limit and try again.',
    unreadableProof:
      "We couldn't read this proof file. Choose a readable PDF, PNG, or JPEG file and try again.",
  },
  ar: {
    title: 'الفوترة والدفع',
    bankInstructions: 'تعليمات التحويل البنكي',
    bankInstructionsBody: 'حوّل المبلغ إلى حساب كيمفاي التجريبي الخاص بـ T060.',
    paymentReference: 'مرجع الدفع',
    amountDue: 'المبلغ المستحق',
    amountNumerals: '١٬٢٥٠',
    billingPeriod: 'فترة الفوترة',
    billingPeriodStart: '١ أكتوبر ٢٠٢٦',
    billingPeriodEnd: '٣١ أكتوبر ٢٠٢٦',
    submissionDate: '١٠ أكتوبر ٢٠٢٦',
    bankReferenceInput: 'مرجع التحويل البنكي',
    proofFileInput: 'إثبات الدفع',
    submit: 'إرسال إثبات الدفع',
    pendingReview: 'قيد المراجعة',
    duplicateBlock: 'يوجد إثبات دفع قيد المراجعة بالفعل لفترة الفوترة هذه.',
    unsupportedProofType:
      'نوع ملف إثبات الدفع غير مدعوم. اختر ملف PDF أو PNG أو JPEG وحاول مرة أخرى.',
    oversizedProof:
      'حجم ملف إثبات الدفع كبير جدًا. اختر ملف PDF أو PNG أو JPEG ضمن حد الرفع وحاول مرة أخرى.',
    unreadableProof:
      'تعذر قراءة ملف إثبات الدفع. اختر ملف PDF أو PNG أو JPEG صالحًا للقراءة وحاول مرة أخرى.',
  },
} as const;

type UploadFailureCause = 'unsupported-type' | 'over-size' | 'unreadable';

const uploadFailures = {
  'unsupported-type': {
    code: 'PAYMENT_PROOF_UNSUPPORTED_TYPE',
    backendMessage: 'Proof file type is not supported',
    localizedCopyKey: 'unsupportedProofType',
  },
  'over-size': {
    code: 'PAYMENT_PROOF_TOO_LARGE',
    backendMessage: 'Proof file exceeds the upload size limit',
    localizedCopyKey: 'oversizedProof',
  },
  unreadable: {
    code: 'PAYMENT_PROOF_UNREADABLE',
    backendMessage: 'Proof file could not be read',
    localizedCopyKey: 'unreadableProof',
  },
} as const satisfies Record<
  UploadFailureCause,
  {
    code: string;
    backendMessage: string;
    localizedCopyKey: 'unsupportedProofType' | 'oversizedProof' | 'unreadableProof';
  }
>;

type Submission = {
  id: string;
  status: 'PendingReview';
  submittedAt: string;
  statusHistory: Array<Record<string, unknown>>;
};

const pendingSubmission: Submission = {
  id: '06000000-0000-4000-8000-000000000060',
  status: 'PendingReview',
  submittedAt: '2026-10-10T12:00:00.000Z',
  statusHistory: [
    {
      status: 'PendingReview',
      at: '2026-10-10T12:00:00.000Z',
    },
  ],
};

async function authenticate(page: Page, baseURL: string): Promise<void> {
  const secureUrl = new URL(baseURL);
  secureUrl.protocol = 'https:';
  await page.context().addCookies([
    {
      name: '__Host-kemfai_session',
      value: 't060-private-fixture-session',
      url: secureUrl.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installBillingFixtures(
  page: Page,
  locale: Locale,
  options: { initialSubmission?: boolean; uploadFailure?: UploadFailureCause } = {},
): Promise<{
  postCount: () => number;
  postedBody: () => string;
  postedContentType: () => string;
}> {
  let postCount = 0;
  let postedBody = '';
  let postedContentType = '';
  let currentSubmission: Submission | null = options.initialSubmission ? pendingSubmission : null;

  await page.route('**/api/billing/subscription', (route) =>
    fulfillJson(route, 200, {
      ...subscription,
      bankInstructions: copy[locale].bankInstructionsBody,
    }),
  );
  await page.route('**/api/billing/payment-submissions', async (route) => {
    if (route.request().method() === 'GET') {
      await fulfillJson(route, 200, currentSubmission ? [currentSubmission] : []);
      return;
    }

    if (route.request().method() !== 'POST') {
      await route.abort('blockedbyclient');
      return;
    }

    postCount += 1;
    postedBody = route.request().postDataBuffer()?.toString('utf8') ?? '';
    postedContentType = route.request().headers()['content-type'] ?? '';

    if (options.uploadFailure) {
      const failure = uploadFailures[options.uploadFailure];
      await fulfillJson(route, 422, {
        statusCode: 422,
        code: failure.code,
        message: failure.backendMessage,
      });
      return;
    }

    currentSubmission = pendingSubmission;
    await fulfillJson(route, 201, currentSubmission);
  });

  return {
    postCount: () => postCount,
    postedBody: () => postedBody,
    postedContentType: () => postedContentType,
  };
}

async function completeProofForm(page: Page): Promise<void> {
  // Fail quickly and explicitly on the intended TDD boundary while T063's
  // billing page is absent, instead of consuming the whole test timeout on
  // sequential form-control lookups against Next's 404 page.
  await expect(page.getByTestId('billing-upload-form')).toBeVisible();
  const referenceInput = page.getByTestId('billing-bank-reference-input');
  const proofInput = page.getByTestId('billing-proof-file-input');
  const submit = page.getByTestId('billing-submit-proof');

  await referenceInput.focus();
  await expect(referenceInput).toBeFocused();
  await page.keyboard.type(bankReference);
  await page.keyboard.press('Tab');
  await expect(proofInput).toBeFocused();
  await proofInput.setInputFiles({
    name: 't060-private-proof.pdf',
    mimeType: 'application/pdf',
    buffer: proofContents,
  });
  await proofInput.focus();
  await page.keyboard.press('Tab');
  await expect(submit).toBeFocused();
  await page.keyboard.press('Enter');
}

async function openBilling(page: Page): Promise<void> {
  const response = await page.goto('/billing');
  expect(response?.status(), 'T063 must provide the real /billing page').toBe(200);
}

test('EN/LTR and AR/RTL show instructions, reference, amount, period, and an accessible upload form', async ({
  browser,
  baseURL,
}) => {
  const english = await openLocalePage(browser, baseURL!, 'en');
  const arabic = await openLocalePage(browser, baseURL!, 'ar');

  try {
    for (const { locale, page } of [
      { locale: 'en' as const, page: english.page },
      { locale: 'ar' as const, page: arabic.page },
    ]) {
      await authenticate(page, baseURL!);
      await installBillingFixtures(page, locale);
      await openBilling(page);
    }

    await expect(english.page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(arabic.page.locator('html')).toHaveAttribute('dir', 'rtl');

    for (const { locale, page } of [
      { locale: 'en' as const, page: english.page },
      { locale: 'ar' as const, page: arabic.page },
    ]) {
      const localized = copy[locale];
      await expect(page.getByRole('heading', { name: localized.title })).toBeVisible();
      await expect(page.getByTestId('billing-bank-instructions')).toBeVisible();
      await expect(page.getByTestId('billing-bank-instructions')).toContainText(
        localized.bankInstructionsBody,
      );
      await expect(page.getByTestId('billing-bank-instructions')).toContainText(
        localized.bankInstructions,
      );
      await expect(page.getByTestId('billing-payment-reference')).toBeVisible();
      await expect(page.getByTestId('billing-payment-reference')).toContainText(
        subscription.paymentReference,
      );
      await expect(page.getByTestId('billing-payment-reference')).toContainText(
        localized.paymentReference,
      );
      await expect(page.getByTestId('billing-amount-due')).toBeVisible();
      await expect(page.getByTestId('billing-amount-due')).toContainText(localized.amountDue);
      await expect(page.getByTestId('billing-amount-due')).toContainText(subscription.currency);
      await expect(page.getByTestId('billing-amount-due')).toContainText(localized.amountNumerals);
      if (locale === 'ar') {
        await expect(page.getByTestId('billing-amount-due')).not.toContainText(/1[,.\s]?250/);
      }
      await expect(page.getByTestId('billing-period')).toBeVisible();
      await expect(page.getByTestId('billing-period')).toContainText(localized.billingPeriod);
      await expect(page.getByTestId('billing-period-start')).toBeVisible();
      await expect(page.getByTestId('billing-period-start')).toHaveAttribute(
        'datetime',
        subscription.billingPeriodStart,
      );
      await expect(page.getByTestId('billing-period-start')).toHaveText(
        localized.billingPeriodStart,
      );
      await expect(page.getByTestId('billing-period-end')).toBeVisible();
      await expect(page.getByTestId('billing-period-end')).toHaveAttribute(
        'datetime',
        subscription.billingPeriodEnd,
      );
      await expect(page.getByTestId('billing-period-end')).toHaveText(localized.billingPeriodEnd);
      await expect(page.getByTestId('billing-upload-form')).toBeVisible();
      await expect(page.getByTestId('billing-bank-reference-input')).toHaveAccessibleName(
        localized.bankReferenceInput,
      );
      await expect(page.getByTestId('billing-proof-file-input')).toHaveAccessibleName(
        localized.proofFileInput,
      );
      await expect(page.getByTestId('billing-submit-proof')).toHaveAccessibleName(localized.submit);
      await assertNoHorizontalOverflow(page);
      await runAxe(page);
    }

    for (const englishText of Object.values(copy.en)) {
      await expect(arabic.page.getByTestId('billing-screen')).not.toContainText(englishText);
    }

    await assertMirrored(
      english.page.getByTestId('billing-bank-instructions'),
      arabic.page.getByTestId('billing-bank-instructions'),
      VIEWPORT.width,
    );
    await assertMirrored(
      english.page.getByTestId('billing-payment-reference'),
      arabic.page.getByTestId('billing-payment-reference'),
      VIEWPORT.width,
    );
    await assertMirrored(
      english.page.getByTestId('billing-upload-form'),
      arabic.page.getByTestId('billing-upload-form'),
      VIEWPORT.width,
    );
    await assertDirectionalIcons(english.page, arabic.page);
  } finally {
    await english.context.close();
    await arabic.context.close();
  }
});

for (const locale of ['en', 'ar'] as const) {
  test(`${locale}: valid proof enters Pending Review and blocks a duplicate active submission`, async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      await authenticate(page, baseURL!);
      const fixture = await installBillingFixtures(page, locale);
      await openBilling(page);

      await completeProofForm(page);

      expect(fixture.postCount()).toBe(1);
      expect(fixture.postedContentType()).toMatch(/^multipart\/form-data;\s*boundary=/i);
      expect(fixture.postedBody()).toContain('name="bankReference"');
      expect(fixture.postedBody()).toContain('name="proofFile"');
      expect(fixture.postedBody()).toContain(bankReference);
      expect(fixture.postedBody()).toContain('t060-private-proof.pdf');
      expect(fixture.postedBody()).toContain('T060 disposable private proof fixture');

      const status = page.getByTestId('billing-submission-status');
      await expect(status).toBeVisible();
      await expect(status).toContainText(copy[locale].pendingReview);
      await expect(page.getByTestId('billing-submission-date')).toBeVisible();
      await expect(page.getByTestId('billing-submission-date')).toHaveAttribute(
        'datetime',
        pendingSubmission.submittedAt,
      );
      await expect(page.getByTestId('billing-submission-date')).toHaveText(
        copy[locale].submissionDate,
      );
      await expect(page.getByTestId('billing-duplicate-block')).toBeVisible();
      await expect(page.getByTestId('billing-duplicate-block')).toContainText(
        copy[locale].duplicateBlock,
      );
      await expect(page.getByTestId('billing-submit-proof')).toBeDisabled();

      // A programmatic click on a disabled native control must not issue a second POST.
      await page
        .getByTestId('billing-submit-proof')
        .evaluate((button: HTMLButtonElement) => button.click());
      expect(fixture.postCount()).toBe(1);
      await runAxe(page);
    } finally {
      await context.close();
    }
  });
}

for (const locale of ['en', 'ar'] as const) {
  test(`${locale}: a Pending Review submission loaded from GET remains visible and blocks a second POST`, async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      await authenticate(page, baseURL!);
      const fixture = await installBillingFixtures(page, locale, { initialSubmission: true });
      await openBilling(page);

      await expect(page.getByTestId('billing-submission-status')).toBeVisible();
      await expect(page.getByTestId('billing-submission-status')).toContainText(
        copy[locale].pendingReview,
      );
      await expect(page.getByTestId('billing-submission-date')).toBeVisible();
      await expect(page.getByTestId('billing-submission-date')).toHaveAttribute(
        'datetime',
        pendingSubmission.submittedAt,
      );
      await expect(page.getByTestId('billing-submission-date')).toHaveText(
        copy[locale].submissionDate,
      );
      await expect(page.getByTestId('billing-duplicate-block')).toBeVisible();
      await expect(page.getByTestId('billing-duplicate-block')).toContainText(
        copy[locale].duplicateBlock,
      );
      await expect(page.getByTestId('billing-submit-proof')).toBeDisabled();
      await page
        .getByTestId('billing-submit-proof')
        .evaluate((button: HTMLButtonElement) => button.click());
      expect(fixture.postCount()).toBe(0);
      await runAxe(page);
    } finally {
      await context.close();
    }
  });
}

for (const cause of Object.keys(uploadFailures) as UploadFailureCause[]) {
  const failure = uploadFailures[cause];

  test(`${cause} proof failure is distinctly actionable and localized without echoing backend English into Arabic`, async ({
    browser,
    baseURL,
  }) => {
    const pages: Array<{ locale: Locale; page: Page; close: () => Promise<void> }> = [];

    try {
      for (const locale of ['en', 'ar'] as const) {
        const { context, page } = await openLocalePage(browser, baseURL!, locale);
        pages.push({ locale, page, close: () => context.close() });
        await authenticate(page, baseURL!);
        await installBillingFixtures(page, locale, { uploadFailure: cause });
        await openBilling(page);
        await completeProofForm(page);
      }

      const englishError = pages[0].page.getByTestId('billing-upload-error');
      const arabicError = pages[1].page.getByTestId('billing-upload-error');
      const expectedEnglish = copy.en[failure.localizedCopyKey];
      const expectedArabic = copy.ar[failure.localizedCopyKey];
      const otherCopyKeys = Object.values(uploadFailures)
        .map(({ localizedCopyKey }) => localizedCopyKey)
        .filter((copyKey) => copyKey !== failure.localizedCopyKey);

      await expect(englishError).toBeVisible();
      await expect(arabicError).toBeVisible();
      await expect(englishError).toHaveText(expectedEnglish);
      await expect(arabicError).toHaveText(expectedArabic);
      await expect(arabicError).not.toContainText(failure.backendMessage);

      for (const otherCopyKey of otherCopyKeys) {
        await expect(englishError).not.toHaveText(copy.en[otherCopyKey]);
        await expect(arabicError).not.toHaveText(copy.ar[otherCopyKey]);
      }

      await runAxe(pages[0].page);
      await runAxe(pages[1].page);
    } finally {
      await Promise.all(pages.map(({ close }) => close()));
    }
  });
}
