import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const submission = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'PendingReview',
  submittedAt: '2026-10-16T10:00:00.000Z',
  statusHistory: [{ status: 'PendingReview', changedAt: '2026-10-16T10:00:00.000Z' }],
  customerEmail: 'customer@example.test',
  tenantId: '22222222-2222-4222-8222-222222222222',
  planName: 'Growth',
  billingPeriodStart: '2026-10-01',
  billingPeriodEnd: '2026-10-31',
  amount: 250,
  currency: 'AED',
  bankReference: 'BANK-REF',
  proofDownloadUrl: 'https://storage.example.test/proof',
};
async function fixtures(page: Page) {
  let items = [submission];
  await page.route('**/api/internal/billing/review-queue', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(items) }),
  );
  await page.route('**/api/internal/billing/payment-submissions/**', async (r) => {
    const action = r.request().url().split('/').pop();
    items = action === 'request-more-info' ? [{ ...submission, status: 'MoreInfoRequested' }] : [];
    await r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: action === 'approve' ? 'Active' : action }),
    });
  });
}
async function authenticate(page: Page, baseURL: string, locale: 'en' | 'ar') {
  const sessionId = `t071-${locale}-internal-session`;
  await fetch('http://127.0.0.1:4100/__e2e/seed', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
  const secure = new URL(baseURL);
  secure.protocol = 'https:';
  await page.context().addCookies([
    {
      name: '__Host-kemfai_internal_session',
      value: sessionId,
      url: secure.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
    { name: 'KEMFAI_LOCALE', value: locale, url: baseURL },
  ]);
}
for (const locale of ['en', 'ar'] as const)
  test(`${locale} queue is directional, keyboard-contained and axe-clean`, async ({
    page,
    baseURL,
  }) => {
    await fixtures(page);
    await authenticate(page, baseURL!, locale);
    await page.goto('/billing-review');
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(page.getByText('customer@example.test').first()).toBeVisible();
    const trigger = page.getByRole('button', { name: locale === 'ar' ? 'رفض' : 'Reject' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const note = page.getByLabel(locale === 'ar' ? 'سبب الرفض مطلوب' : 'Required rejection reason');
    const cancel = page.getByRole('button', { name: locale === 'ar' ? 'إلغاء' : 'Cancel' });
    await expect(note).toBeFocused();
    await note.press('Shift+Tab');
    await expect(cancel).toBeFocused();
    await cancel.press('Tab');
    await expect(note).toBeFocused();
    await expect(page.getByTestId('billing-review-background')).toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

test('request-more-info requires details and becomes non-actionable', async ({ page, baseURL }) => {
  await fixtures(page);
  await authenticate(page, baseURL!, 'en');
  await page.goto('/billing-review');
  await page.getByRole('button', { name: 'Request more information' }).click();
  await page.getByRole('button', { name: 'Confirm decision' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Required details').fill('Upload the complete receipt');
  await page.getByRole('button', { name: 'Confirm decision' }).click();
  await expect(page.getByText(/Awaiting customer resubmission/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});
