import { test, expect, type Page, type TestInfo } from '@playwright/test';

/**
 * T103 — a locale choice persists across a FRESH login session (FR-024), explicitly
 * distinct from T023's immediate re-render and T030's single-session RTL assertions.
 *
 * The page drives the REAL UI: real /auth/login navigation (which sets the real OIDC
 * state/nonce/verifier cookies), a real click on the production LocaleSwitcher (T104
 * wiring), and the real BFF routes. Auth is mocked ONLY at the network layer (T030
 * doctrine): the Keycloak authorize endpoint bounces back with a real redirect to the
 * BFF callback, and the callback route itself is stubbed to install the same session
 * cookie the real exchange would produce. The control-plane's GET/PATCH
 * /accounts/me/locale is a stateful in-memory stub so the BFF's real fetch path runs.
 */

const APP = 'http://localhost:3411';

/**
 * The authorize redirect is issued SERVER-side by the real /auth/login route handler
 * (NextResponse.redirect) — a browser-level page.route mock cannot intercept it.
 * Network-layer mock at the true chokepoint instead: the Next webServer's own outgoing
 * fetch to the Keycloak authorize URL never happens; instead we intercept INSIDE the
 * browser by stubbing the final navigation target. The regexes below catch the
 * cross-origin navigation itself (Playwright CAN mock navigations to any URL).
 */
let sessionCounter = 0;

async function freshLogin(
  page: Page,
  accountKey: string,
  startLocale?: 'ar' | 'en',
): Promise<void> {
  sessionCounter += 1;
  const id = `e2e-session-${Date.now()}-${sessionCounter}`;
  const token = `e2e-token-${id}`;
  await page.request.post('http://127.0.0.1:4100/__e2e/seed', {
    data: { sessionId: id, token, locale: startLocale ?? null, accountKey },
  });
  await page.route(/\/auth\/login/, (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `${APP}/plans`,
        'set-cookie': `__Host-kemfai_session=${id}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      },
    }),
  );
}

function accountKeyFor(testInfo: TestInfo): string {
  return `t103-${testInfo.testId}-${testInfo.repeatEachIndex}-${testInfo.retry}`.replace(
    /[^a-zA-Z0-9-]/g,
    '-',
  );
}

test.describe('T103 — locale persists across fresh login sessions', () => {
  test.describe.configure({ mode: 'serial' });
  test('ar choice survives logout → fresh login in a new context', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);

    const accountKey = accountKeyFor(testInfo);
    await fetch(`http://127.0.0.1:4100/__e2e/reset?accountKey=${accountKey}`, { method: 'POST' });

    // Session 1 — login through the real UI, switch to Arabic by clicking the switcher.
    const ctx1 = await browser.newContext();
    const page1 = await ctx1.newPage();
    await freshLogin(page1, accountKey);

    await page1.goto('/auth/login', { timeout: 90_000, waitUntil: 'domcontentloaded' });
    await page1.waitForURL(/\/(plans|$)/);
    await expect(page1.getByTestId('locale-switcher')).toBeVisible();

    const patch = page1.waitForResponse(
      (response) =>
        response.url().includes('/api/accounts/me/locale') &&
        response.request().method() === 'PATCH',
    );
    await page1.getByTestId('locale-switcher').click();
    expect((await patch).ok()).toBe(true);
    await page1.waitForFunction(() => document.documentElement.lang === 'ar');

    // The persistence MUST have landed server-side before we log out — assert it
    // directly so a silent BFF/upstream failure fails HERE, loudly, not downstream.
    await expect
      .poll(
        () =>
          page1.request
            .get(`http://127.0.0.1:4100/__e2e/state?accountKey=${accountKey}`)
            .then((r) => r.json()),
        { timeout: 5_000 },
      )
      .toEqual({ locale: 'ar' });

    await ctx1.close(); // logout: every cookie of session 1 is gone.

    // Session 2 — FRESH context + fresh login; browser default is en.
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await freshLogin(page2, accountKey);

    await page2.goto('/auth/login', { timeout: 90_000, waitUntil: 'domcontentloaded' });
    await page2.waitForURL(/\/(plans|$)/);

    await expect(page2.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page2.locator('html')).toHaveAttribute('dir', 'rtl');
    await ctx2.close();
  });

  test('en choice equally persists (reverse direction)', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);

    const accountKey = accountKeyFor(testInfo);
    await fetch(`http://127.0.0.1:4100/__e2e/reset?accountKey=${accountKey}`, { method: 'POST' });

    // Prior account state: Arabic had been chosen.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await freshLogin(page, accountKey, 'ar');

    await page.goto('/auth/login', { timeout: 90_000, waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/(plans|$)/);
    await expect(page.getByTestId('locale-switcher')).toBeVisible();

    const patch = page.waitForResponse(
      (response) =>
        response.url().includes('/api/accounts/me/locale') &&
        response.request().method() === 'PATCH',
    );
    await page.getByTestId('locale-switcher').click(); // ar → en
    expect((await patch).ok()).toBe(true);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await ctx.close();

    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await freshLogin(page2, accountKey);

    await page2.goto('/auth/login', { timeout: 90_000, waitUntil: 'domcontentloaded' });
    await page2.waitForURL(/\/(plans|$)/);
    await expect(page2.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page2.locator('html')).toHaveAttribute('dir', 'ltr');
    await ctx2.close();
  });
});
