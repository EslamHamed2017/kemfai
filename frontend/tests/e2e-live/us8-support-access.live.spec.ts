import { expect, test, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
};
function flag(enabled: boolean) {
  execFileSync('docker', [
    'exec',
    required('US8_PG_CONTAINER'),
    'psql',
    '-U',
    required('US8_PG_USER'),
    '-d',
    required('US8_CONTROL_DB'),
    '-X',
    '-q',
    '-c',
    `UPDATE feature_flag SET enabled=${enabled ? 'true' : 'false'} WHERE feature_key='module.support_access'`,
  ]);
}
async function ownerPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const url = new URL(required('US8_BASE_URL'));
  url.protocol = 'https:';
  await context.addCookies([
    {
      name: '__Host-kemfai_session',
      value: required('US8_SESSION_A'),
      url: url.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  return context.newPage();
}
async function screenshot(page: Page, output: (name: string) => string, name: string) {
  for (const [suffix, width, height] of [
    ['desktop', 1280, 900],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: output(`${name}-${suffix}.png`), fullPage: true });
  }
}

test.describe.serial('US8 genuine owner/support journey', () => {
  test('owner creates with mandatory expiry, sees full history, revokes, and renders EN/AR RTL accessibly', async ({
    browser,
  }, info) => {
    const page = await ownerPage(browser);
    await page.goto('/support-access');
    await expect(page.getByTestId('support-access-empty')).toBeVisible();
    const expiry = page.getByLabel(/Access expires/i);
    await expect(expiry).toHaveAttribute('required', '');
    await expiry.fill(new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16));
    await page.getByRole('button', { name: /Grant temporary access/i }).click();
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
    await expect(page.getByText(required('US8_OWNER_ACCOUNT_ID'))).toBeVisible();
    const grants = (await fetch(`${required('US8_API_URL')}/support-access/grants`, {
      headers: { authorization: `Bearer ${required('US8_OWNER_A_TOKEN')}` },
    }).then((response) => response.json())) as Array<{ id: string }>;
    const grantId = grants[0].id;
    expect(
      (
        await fetch(
          `${required('US8_API_URL')}/internal/support-access/workspaces/${required('US8_TENANT_A_ID')}/summary?grantId=${grantId}`,
          { headers: { authorization: `Bearer ${required('US8_SUPPORT_TOKEN')}` } },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(
          `${required('US8_API_URL')}/internal/support-access/workspaces/${required('US8_TENANT_B_ID')}/summary?grantId=${grantId}`,
          { headers: { authorization: `Bearer ${required('US8_SUPPORT_TOKEN')}` } },
        )
      ).status,
    ).toBe(403);
    await page.reload();
    await expect(page.getByText('Allowed', { exact: true })).toBeVisible();
    await expect(page.getByText('Denied: wrong_tenant', { exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await screenshot(page, (name) => info.outputPath(name), 'active-en');
    await page.getByRole('button', { name: 'العربية' }).click();
    await expect(page.locator('main')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'وصول مؤقت للدعم' })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await screenshot(page, (name) => info.outputPath(name), 'active-ar');
    await page.getByRole('button', { name: /إلغاء الآن/ }).click();
    await expect(page.getByText('ملغى', { exact: true })).toBeVisible();
    await expect(page.getByText(/تاريخ الإلغاء/)).toBeVisible();
    await screenshot(page, (name) => info.outputPath(name), 'revoked-ar');
  });

  test('BFF enforces CSRF and feature flag removes route, nav and DOM', async ({ browser }) => {
    const page = await ownerPage(browser);
    await page.goto('/support-access');
    const csrf = await fetch(`${required('US8_BASE_URL')}/api/support-access/grants`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.invalid',
        cookie: `__Host-kemfai_session=${required('US8_SESSION_A')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expiresAt: new Date(Date.now() + 3600000).toISOString() }),
    }).then((response) => response.status);
    expect(csrf).toBe(403);
    expect(
      (
        await fetch(`${required('US8_API_URL')}/support-access/grants`, {
          headers: { authorization: `Bearer ${required('US8_OWNER_A_TOKEN')}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(
          `${required('US8_API_URL')}/internal/support-access/workspaces/${required('US8_TENANT_A_ID')}/summary?grantId=00000000-0000-4000-8000-000000000000`,
          { headers: { authorization: `Bearer ${required('US8_CUSTOMER_SUPPORT_SPOOF_TOKEN')}` } },
        )
      ).status,
    ).toBe(401);
    flag(false);
    await page.goto('/support-access');
    await expect(page.getByTestId('support-access-navigation')).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: /Temporary support access|وصول مؤقت للدعم/ }),
    ).toHaveCount(0);
    expect(
      (
        await fetch(`${required('US8_API_URL')}/support-access/grants`, {
          headers: { authorization: `Bearer ${required('US8_OWNER_A_TOKEN')}` },
        })
      ).status,
    ).toBe(404);
    flag(true);
  });

  test('shows genuine loading and error states', async ({ browser }, info) => {
    const page = await ownerPage(browser);
    await page.route('**/api/support-access/grants', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.fulfill({ status: 502, body: '{}' });
    });
    await page.goto('/support-access');
    await expect(page.getByText(/Loading support access history/)).toBeVisible();
    await screenshot(page, (name) => info.outputPath(name), 'loading');
    await expect(page.getByText(/could not be loaded/)).toBeVisible();
    await screenshot(page, (name) => info.outputPath(name), 'error');
  });
});
