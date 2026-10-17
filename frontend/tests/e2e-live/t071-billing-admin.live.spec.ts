import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import ar from '../../src/locales/ar/common.json';
import en from '../../src/locales/en/common.json';
import {
  isOwnedKeycloakLoginUrl,
  KEYCLOAK_PASSWORD_SELECTOR,
} from './t071-keycloak-login-locators';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the owned T071 live fixture`);
  return value;
};

async function login(page: Page) {
  await page.goto('/internal-auth/login');
  await page.getByLabel(/username|email/i).fill(required('T071_BILLING_ADMIN_EMAIL'));
  await page.locator(KEYCLOAK_PASSWORD_SELECTOR).fill(required('T071_BILLING_ADMIN_PASSWORD'));
  await Promise.all([
    page.waitForURL('**/billing-review'),
    page.getByRole('button', { name: /sign in/i }).click(),
  ]);
}

async function selectReference(page: Page, reference: string) {
  const choices = page.getByRole('navigation').getByRole('button');
  for (let index = 0; index < (await choices.count()); index += 1) {
    await choices.nth(index).click();
    if (await page.getByText(reference, { exact: true }).isVisible()) return;
  }
  throw new Error(`submission ${reference} was not present in the real queue`);
}

async function decide(page: Page, reference: string, action: string, note?: string) {
  await selectReference(page, reference);
  const opener = page.getByRole('button', { name: action, exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('billing-review-background')).toHaveAttribute('inert', '');
  await page.getByTestId('billing-review-background').locator('button').first().focus();
  expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
  const textbox = dialog.getByRole('textbox');
  if (note) await textbox.fill(note);
  const cancel = dialog.getByRole('button', { name: en.billingReview.actions.cancel, exact: true });
  const confirm = dialog.getByRole('button', {
    name: en.billingReview.actions.confirm,
    exact: true,
  });
  const focusOrder = note ? [textbox, confirm, cancel] : [confirm, cancel];
  for (let index = 0; index < focusOrder.length; index += 1) {
    await focusOrder[index].focus();
    await page.keyboard.press('Tab');
    await expect(focusOrder[(index + 1) % focusOrder.length]).toBeFocused();
  }
  for (let index = 0; index < focusOrder.length; index += 1) {
    await focusOrder[index].focus();
    await page.keyboard.press('Shift+Tab');
    await expect(focusOrder[(index - 1 + focusOrder.length) % focusOrder.length]).toBeFocused();
  }
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  await opener.click();
  if (note) await dialog.getByRole('textbox').fill(note);
  const replacementPromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/internal/billing/review-queue' &&
      response.request().method() === 'GET'
    );
  });
  await dialog
    .getByRole('button', { name: en.billingReview.actions.confirm, exact: true })
    .click();
  const replacementResponse = await replacementPromise;
  expect(replacementResponse.status()).toBe(200);
  const replacement: unknown = await replacementResponse.json();
  expect(Array.isArray(replacement)).toBe(true);
  const remains = (replacement as Array<Record<string, unknown>>).some(
    (item) => item.bankReference === reference,
  );
  await expect(page.getByText(reference, { exact: true })).toHaveCount(remains ? 1 : 0);
}

async function passwordToken(
  request: APIRequestContext,
  url: string,
  clientId: string,
  email: string,
  password: string,
) {
  const response = await request.post(url, {
    form: { grant_type: 'password', client_id: clientId, username: email, password },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).access_token as string;
}

test('real UI performs all decisions, proof, containment, RTL/axe and measured SC-008', async ({
  page,
  request,
}) => {
  const started = Date.now();
  const queueResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/internal/billing/review-queue' &&
      response.request().method() === 'GET'
    );
  });
  await login(page);
  const queueResponse = await queueResponsePromise;
  expect(queueResponse.status()).toBe(200);
  const queue = (await queueResponse.json()) as Array<Record<string, unknown>>;
  expect(queue).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: required('T071_APPROVE_ID'),
        status: 'PendingReview',
        customerEmail: required('T071_APPROVE_CUSTOMER_EMAIL'),
        bankReference: required('T071_APPROVE_REF'),
        tenantId: expect.any(String),
        planName: expect.any(String),
        billingPeriodStart: expect.any(String),
        billingPeriodEnd: expect.any(String),
        amount: expect.any(Number),
        currency: expect.any(String),
        submittedAt: expect.any(String),
        statusHistory: expect.any(Array),
        proofDownloadUrl: expect.any(String),
      }),
    ]),
  );
  expect((await page.context().cookies()).map(({ name }) => name)).not.toEqual(
    expect.arrayContaining(['access_token', 'refresh_token']),
  );
  expect(await page.evaluate(() => `${localStorage.length}:${sessionStorage.length}`)).toBe('0:0');
  await expect(page.getByText(required('T071_APPROVE_CUSTOMER_EMAIL')).first()).toBeVisible();

  await selectReference(page, required('T071_APPROVE_REF'));
  const proofHref = await page
    .getByRole('link', { name: en.billingReview.actions.proof, exact: true })
    .getAttribute('href');
  expect(proofHref).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+\//);
  const proof = await request.get(proofHref!);
  expect(proof.ok()).toBeTruthy();
  expect((await proof.body()).subarray(0, 4).toString()).toBe('%PDF');

  await decide(page, required('T071_APPROVE_REF'), en.billingReview.actions.approve);
  await expect(page.getByText(en.billingReview.messages.approved, { exact: true })).toBeVisible();
  await decide(
    page,
    required('T071_REJECT_REF'),
    en.billingReview.actions.reject,
    'Synthetic rejection reason',
  );
  await expect(page.getByText(en.billingReview.messages.rejected, { exact: true })).toBeVisible();
  await decide(
    page,
    required('T071_INFO_REF'),
    en.billingReview.actions.moreInfo,
    'Upload a clearer proof',
  );
  await expect(page.getByText(en.billingReview.messages.moreInfo, { exact: true })).toBeVisible();
  await selectReference(page, required('T071_INFO_REF'));
  await expect(
    page.getByText(en.billingReview.messages.awaitingCustomer, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: en.billingReview.actions.approve, exact: true }),
  ).toHaveCount(0);

  await decide(
    page,
    required('T071_FAULT_REF'),
    en.billingReview.actions.reject,
    'Controlled ambiguous response',
  );
  await expect(page.getByText(en.billingReview.messages.unknown, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(required('T071_FAULT_REF'), { exact: true })).toHaveCount(0);

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByTestId('locale-switcher').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: ar.billingReview.title, exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  const milliseconds = Date.now() - started;
  expect(milliseconds).toBeLessThan(300_000);
  await writeFile(required('T071_SC008_EVIDENCE'), `${JSON.stringify({ milliseconds })}\n`, {
    mode: 0o600,
  });
});

test('real auth boundaries, CSRF, 409 race, refresh/logout and no replay', async ({ page, request }) => {
  const api = required('T071_API_URL');
  const internalUrl = required('T071_INTERNAL_TOKEN_URL');
  const adminToken = await passwordToken(
    request, internalUrl, required('T071_CLIENT_ID'),
    required('T071_BILLING_ADMIN_EMAIL'), required('T071_BILLING_ADMIN_PASSWORD'),
  );
  const raceToken = await passwordToken(
    request, internalUrl, required('T071_CLIENT_ID'),
    required('T071_RACE_EMAIL'), required('T071_RACE_PASSWORD'),
  );
  const wrongToken = await passwordToken(
    request, internalUrl, required('T071_CLIENT_ID'),
    required('T071_WRONG_EMAIL'), required('T071_WRONG_PASSWORD'),
  );
  const wrongAudienceToken = await passwordToken(
    request, internalUrl, required('T071_WRONG_AUDIENCE_CLIENT_ID'),
    required('T071_WRONG_EMAIL'), required('T071_WRONG_PASSWORD'),
  );
  const customerToken = await passwordToken(
    request, required('T071_CUSTOMER_TOKEN_URL'), required('T071_CUSTOMER_CLIENT_ID'),
    required('T071_CUSTOMER_EMAIL'), required('T071_CUSTOMER_PASSWORD'),
  );
  const raw = `${api}/internal/billing/payment-submissions/${required('T071_RACE_ID')}/approve`;
  for (const token of [wrongToken, wrongAudienceToken, customerToken]) {
    expect([401, 403]).toContain((await request.post(raw, { headers: { authorization: `Bearer ${token}` } })).status());
  }
  const results = await Promise.all([
    request.post(raw, { headers: { authorization: `Bearer ${adminToken}` } }),
    request.post(raw, { headers: { authorization: `Bearer ${raceToken}` } }),
  ]);
  expect(results.map((result) => result.status()).sort()).toEqual([200, 409]);
  expect((await request.post('/api/internal/billing/payment-submissions/x/approve', {
    headers: { origin: 'https://invalid.example' },
  })).status()).toBe(403);

  await login(page);
  await page.waitForTimeout(15_500);
  const { refreshStatus, logoutStatus } = await page.evaluate(async () => {
    const [refresh, logout] = await Promise.all([
      window.fetch('/api/internal/billing/review-queue'),
      window.fetch('/api/internal/auth/logout', { method: 'POST' }),
    ]);
    return { refreshStatus: refresh.status, logoutStatus: logout.status };
  });
  expect([200, 401, 409, 502, 503]).toContain(refreshStatus);
  expect([200, 502]).toContain(logoutStatus);
  await page.goto('/billing-review');
  const callback = new URL('/internal-auth/callback', required('T071_BASE_URL')).toString();
  expect(
    isOwnedKeycloakLoginUrl(page.url(), required('T071_INTERNAL_ISSUER'), callback),
  ).toBe(true);
  await expect(page.locator(KEYCLOAK_PASSWORD_SELECTOR)).toBeVisible();
  expect((await page.context().cookies()).map(({ name }) => name)).not.toContain(
    '__Host-kemfai_internal_session',
  );
  expect((await page.request.get('/api/internal/billing/review-queue')).status()).toBe(401);
  const expiredReplay = await request.post(raw, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  expect(expiredReplay.status()).toBe(401);
  const freshAdminToken = await passwordToken(
    request,
    internalUrl,
    required('T071_CLIENT_ID'),
    required('T071_BILLING_ADMIN_EMAIL'),
    required('T071_BILLING_ADMIN_PASSWORD'),
  );
  expect(
    await request
      .post(raw, { headers: { authorization: `Bearer ${freshAdminToken}` } })
      .then((response) => response.status()),
  ).toBe(409);
});
