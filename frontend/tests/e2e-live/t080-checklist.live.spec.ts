import { execFileSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
};
function sql(statement: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      required('T080_PG_CONTAINER'),
      'psql',
      '-U',
      required('T080_PG_USER'),
      '-d',
      required('T080_CONTROL_DB'),
      '-X',
      '-q',
      '-t',
      '-A',
      '-c',
      statement,
    ],
    { encoding: 'utf8' },
  ).trim();
}
async function rpc(service: string, method: string, args: unknown[]) {
  const response = await fetch(`${required('T080_ODOO_URL')}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service, method, args },
      id: 1,
    }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`Odoo RPC failed: ${JSON.stringify(body.error)}`);
  return body.result;
}
async function odoo(
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
) {
  const db = required('T080_ODOO_DB_A');
  const password = required('T080_ODOO_PASSWORD');
  const uid = await rpc('common', 'login', [db, required('T080_ODOO_LOGIN'), password]);
  return rpc('object', 'execute_kw', [db, uid, password, model, method, args, kwargs]);
}
async function pageFor(browser: Browser, session: string): Promise<Page> {
  const context = await browser.newContext();
  const url = new URL(required('T080_BASE_URL'));
  url.protocol = 'https:';
  await context.addCookies([
    {
      name: '__Host-kemfai_session',
      value: session,
      url: url.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  return context.newPage();
}

async function captureDesktopMobile(
  page: Page,
  outputPath: (name: string) => string,
  name: string,
) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: outputPath(`${name}-desktop.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: outputPath(`${name}-mobile.png`), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.describe.serial('T080 owned real checklist journey', () => {
  test('real Odoo create/archive/delete stays live through Next BFF and normal Nest AppModule', async ({
    browser,
  }, testInfo) => {
    const page = await pageFor(browser, required('T080_SESSION_A'));
    await page.goto('/checklist');
    await expect(page.getByTestId('checklist-empty')).toBeVisible();
    await expect(page.getByTestId('activation-gate')).toBeVisible();
    await expect(page.getByTestId('checklist-firstInvoice')).toContainText('Not complete');
    const setupTargets = [
      ['customer', '/workspace/modules/module.sales', /\/workspace\/modules\/module\.sales$/],
      ['bank', '/workspace/modules/module.accounting', /\/workspace\/modules\/module\.accounting$/],
      ['product', '/workspace/modules/module.inventory', /\/workspace\/modules\/module\.inventory$/],
      ['firstInvoice', '/billing', /\/billing$/],
    ] as const;
    for (const [item, href, url] of setupTargets) {
      const action = page.getByTestId(`checklist-${item}`).getByRole('link');
      await expect(action).toHaveAttribute('href', href);
      await action.click();
      await expect(page).toHaveURL(url);
      if (item === 'firstInvoice') {
        await expect(page.getByRole('heading').first()).toBeVisible();
      } else {
        await expect(
          page.getByText('This module is enabled and available in your workspace.', { exact: true }),
        ).toBeVisible();
      }
      await page.goto('/checklist');
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await captureDesktopMobile(page, (name) => testInfo.outputPath(name), 'empty-gated-en');

    const company = Number(
      await odoo('res.company', 'search', [[]], { limit: 1 }).then((v) => (v as number[])[0]),
    );
    const customer = Number(
      await odoo('res.partner', 'create', [
        { name: 'T080 Customer', customer_rank: 1, company_id: company },
      ]),
    );
    await expect(page.getByTestId('checklist-customer')).toContainText('Complete', {
      timeout: 10_000,
    });
    await captureDesktopMobile(page, (name) => testInfo.outputPath(name), 'partial-en');
    const companyPartner = Number(
      (
        (await odoo('res.company', 'read', [[company], ['partner_id']])) as Array<{
          partner_id: [number, string];
        }>
      )[0].partner_id[0],
    );
    const bank = Number(
      await odoo('res.partner.bank', 'create', [
        { acc_number: 'T080-ACCOUNT', partner_id: companyPartner },
      ]),
    );
    const product = Number(
      await odoo('product.product', 'create', [
        { name: 'T080 Service', sale_ok: true, company_id: company },
      ]),
    );
    await expect(page.getByTestId('checklist-firstInvoice')).toContainText('Complete', {
      timeout: 10_000,
    });
    await expect(page.getByTestId('activation-gate')).toBeVisible();
    await captureDesktopMobile(
      page,
      (name) => testInfo.outputPath(name),
      'ready-subscription-gated-en',
    );

    await odoo('product.product', 'write', [[product], { active: false }]);
    await expect(page.getByTestId('checklist-product')).toContainText('Not complete', {
      timeout: 10_000,
    });
    await odoo('product.product', 'write', [[product], { active: true }]);
    await odoo('res.partner', 'unlink', [[customer]]);
    await expect(page.getByTestId('checklist-customer')).toContainText('Not complete', {
      timeout: 10_000,
    });
    await odoo('res.partner', 'create', [
      { name: 'T080 Customer 2', customer_rank: 1, company_id: company },
    ]);
    await odoo('res.partner.bank', 'unlink', [[bank]]);
    await expect(page.getByTestId('checklist-bank')).toContainText('Not complete', {
      timeout: 10_000,
    });

    sql(
      `UPDATE subscription SET status='Active' WHERE tenant_id='${required('T080_TENANT_A_ID')}'`,
    );
    await page.reload();
    await expect(page.getByTestId('activation-active')).toBeVisible();
    await captureDesktopMobile(page, (name) => testInfo.outputPath(name), 'active-en');
    await page.getByRole('button', { name: 'العربية' }).click();
    await expect(page.locator('main')).toHaveAttribute('dir', 'rtl');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: testInfo.outputPath('active-ar-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('active-ar-mobile.png'), fullPage: true });
  });

  test('two tenants, auth, raw HTTP, feature flag, trial guard, and response secrecy', async ({
    browser,
  }) => {
    const beta = await pageFor(browser, required('T080_SESSION_B'));
    await beta.goto('/checklist');
    await expect(beta.getByTestId('checklist-empty')).toBeVisible();
    const raw = await fetch(`${required('T080_API_URL')}/onboarding/checklist`, {
      headers: { authorization: `Bearer ${required('T080_TOKEN_A')}` },
    });
    expect(raw.status).toBe(200);
    const text = await raw.text();
    expect(text).not.toMatch(/odoo|database|8069|hostname/i);
    expect(
      (
        await fetch(`${required('T080_API_URL')}/onboarding/checklist`, {
          headers: { authorization: `Bearer ${required('T080_TOKEN_NON_OWNER')}` },
        })
      ).status,
    ).toBe(403);
    // GET is safe/read-only and has no CSRF token contract: a hostile Origin must neither
    // mutate state nor bypass authentication. The same authenticated response is returned,
    // while the BFF's existing same-origin CSRF check remains mandatory for mutations.
    const crossSiteGet = await fetch(`${required('T080_API_URL')}/onboarding/checklist`, {
      headers: {
        authorization: `Bearer ${required('T080_TOKEN_A')}`,
        origin: 'https://foreign.example.invalid',
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(crossSiteGet.status).toBe(200);
    expect(await crossSiteGet.text()).toBe(text);
    expect((await fetch(`${required('T080_API_URL')}/onboarding/checklist`)).status).toBe(401);
    sql("UPDATE feature_flag SET enabled=false WHERE feature_key='module.onboarding_checklist'");
    expect((await beta.goto('/checklist'))?.status()).toBe(404);
    expect(
      (
        await fetch(`${required('T080_API_URL')}/onboarding/checklist`, {
          headers: { authorization: `Bearer ${required('T080_TOKEN_A')}` },
        })
      ).status,
    ).toBe(404);
    sql(
      `UPDATE feature_flag SET enabled=true WHERE feature_key='module.onboarding_checklist'; UPDATE subscription SET status='PendingActivation',current_period_end=current_date-30 WHERE tenant_id='${required('T080_TENANT_A_ID')}'; UPDATE tenant SET ready_at=current_date-30 WHERE id='${required('T080_TENANT_A_ID')}'`,
    );
    expect(
      (
        await fetch(`${required('T080_API_URL')}/onboarding/checklist`, {
          headers: { authorization: `Bearer ${required('T080_TOKEN_A')}` },
        })
      ).status,
    ).toBe(403);
  });

  test('loading and error states are accessible and capturable', async ({ browser }, testInfo) => {
    const page = await pageFor(browser, required('T080_SESSION_B'));
    await page.route('**/api/onboarding/checklist', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({ status: 502, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/checklist');
    await captureDesktopMobile(page, (name) => testInfo.outputPath(name), 'loading');
    await expect(page.getByText(/couldn't load|تعذر تحميل/)).toBeVisible();
    await captureDesktopMobile(page, (name) => testInfo.outputPath(name), 'error');
  });
});
