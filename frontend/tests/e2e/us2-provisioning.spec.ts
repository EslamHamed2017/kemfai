import { test, expect, type Page } from '@playwright/test';
import en from '../../src/locales/en/common.json';
import ar from '../../src/locales/ar/common.json';
import { openLocalePage, assertMirrored, assertNoHorizontalOverflow, runAxe, VIEWPORT } from './support/rtl';
async function authenticated(page: Page, baseURL: string) {
  await page.route('**/auth/login?e2e-provisioning', (route) => route.fulfill({ status: 302, headers: { location: `${baseURL}/provisioning`, 'set-cookie': '__Host-kemfai_session=playwright-session; Path=/; Secure; HttpOnly; SameSite=Lax' } }));
  await page.goto('/auth/login?e2e-provisioning');
}
for (const locale of ['en', 'ar'] as const) {
  test(`${locale}: loading polls, failure retry, status transition and contact`, async ({ browser, baseURL }) => {
    const { context, page } = await openLocalePage(browser, baseURL!, locale);
    try {
      await authenticated(page, baseURL!);
      let count = 0, retried = false, posts = 0;
      await page.route('**/api/tenants/me', async (route) => {
        count++;
        const status = retried ? (count < 4 ? 'Creating' : 'Ready') : (count < 2 ? 'Creating' : 'Failed');
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status }) });
      });
      await page.route('**/api/tenants/me/provisioning-retry', async (route) => {
        posts++; retried = true; await route.fulfill({ status: 202 });
      });
      await page.goto('/provisioning');
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.getByTestId('provisioning-loading')).toContainText((locale === 'ar' ? ar : en).provisioning.settingUp);
      await expect(page.getByTestId('locale-switcher')).toBeVisible();
      await expect(page.getByTestId('provisioning-failure')).toContainText((locale === 'ar' ? ar : en).provisioning.failed.title, { timeout: 12000 });
      expect(await page.getByTestId('provisioning-support').getAttribute('href')).toMatch(/^mailto:support@example\.test\?subject=/);
      await runAxe(page);
      await page.getByTestId('provisioning-retry').click();
      expect(posts).toBe(1);
      await expect(page.getByTestId('provisioning-ready')).toContainText((locale === 'ar' ? ar : en).provisioning.ready.title, { timeout: 12000 });
      await expect(page.getByTestId('provisioning-ready').getByRole('link')).toHaveAttribute('href', '/mfa');
      await assertNoHorizontalOverflow(page);
      await runAxe(page);
    } finally { await context.close(); }
  });
}
// T056 round-5 binding resolution (item 4) — the provisioning screen renders the ONE
// shared `SignOutButton` (binding review point 6), and clicking it must actually invoke
// the real signOut() handler end to end: POST the logout BFF route, then hard-navigate to
// the login page. `/auth/login` itself is intercepted here (as `authenticated()` above
// already does for its own `?e2e-provisioning` variant) purely to stop this suite's own
// navigation from leaving its mocked environment and hitting the real Keycloak redirect
// `/auth/login` would otherwise issue — the button/handler/BFF-call/navigation sequence
// under test is exercised for real.
test('the shared sign-out control is present and triggers a real logout POST + navigation to login', async ({ browser, baseURL }) => {
  const { context, page } = await openLocalePage(browser, baseURL!, 'en');
  try {
    await authenticated(page, baseURL!);
    await page.route('**/api/tenants/me', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'Creating' }) }),
    );
    let logoutCalls = 0;
    await page.route('**/api/auth/logout', async (route) => {
      logoutCalls += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ outcome: 'confirmed' }) });
    });
    await page.route('**/auth/login', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>login</body></html>' }),
    );
    await page.goto('/provisioning');

    const signOutButton = page.getByTestId('sign-out-button');
    await expect(signOutButton).toBeVisible();
    await signOutButton.click();

    await page.waitForURL('**/auth/login');
    expect(logoutCalls).toBe(1);
  } finally {
    await context.close();
  }
});

test('EN/AR failure actions mirror and network recovery stays actionable', async ({ browser, baseURL }) => {
  const english = await openLocalePage(browser, baseURL!, 'en');
  const arabic = await openLocalePage(browser, baseURL!, 'ar');
  try {
    for (const { page } of [english, arabic]) {
      await authenticated(page, baseURL!);
      let healthy = false;
      await page.route('**/api/tenants/me', (route) => healthy ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"Failed"}' }) : route.abort());
      await page.route('**/api/tenants/me/provisioning-retry', (route) => route.fulfill({ status: 409 }));
      await page.goto('/provisioning');
      await expect(page.getByTestId('provisioning-failure')).toContainText((page === english.page ? en : ar).provisioning.connection.title);
      healthy = true;
      await page.getByTestId('provisioning-refresh').click();
      await expect(page.getByTestId('provisioning-retry')).toBeVisible();
      await page.getByTestId('provisioning-retry').click();
      await expect(page.getByRole('alert').filter({ hasText: (page === english.page ? en : ar).provisioning.conflict })).toBeVisible();
      await runAxe(page);
    }
    await assertMirrored(english.page.getByTestId('provisioning-retry'), arabic.page.getByTestId('provisioning-retry'), VIEWPORT.width);
    await assertMirrored(english.page.getByTestId('provisioning-support'), arabic.page.getByTestId('provisioning-support'), VIEWPORT.width);
  } finally { await english.context.close(); await arabic.context.close(); }
});
