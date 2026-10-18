import { expect, test, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { execFileSync, spawn } from 'node:child_process';

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
      required('US8_PG_CONTAINER'),
      'psql',
      '-U',
      required('US8_PG_USER'),
      '-d',
      required('US8_CONTROL_DB'),
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
function flag(enabled: boolean) {
  sql(
    `UPDATE feature_flag SET enabled=${enabled ? 'true' : 'false'} WHERE feature_key='module.support_access'`,
  );
}
function supportUrl(tenantId: string, grantId?: string) {
  const query = grantId === undefined ? '' : `?grantId=${encodeURIComponent(grantId)}`;
  return `${required('US8_API_URL')}/internal/support-access/workspaces/${tenantId}/summary${query}`;
}
async function createGrant(expiresAt: Date): Promise<string> {
  const response = await fetch(`${required('US8_API_URL')}/support-access/grants`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${required('US8_OWNER_A_TOKEN')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ granteeRole: 'Support', expiresAt: expiresAt.toISOString() }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
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
  let lifecycleGrantId: string;

  test('owner creates with mandatory expiry, sees full history, revokes, and renders EN/AR RTL accessibly', async ({
    browser,
  }, info) => {
    const page = await ownerPage(browser);
    await page.goto('/support-access');
    await expect(page.getByTestId('support-access-empty')).toBeVisible();
    await screenshot(page, (name) => info.outputPath(name), 'empty-en');
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
    lifecycleGrantId = grantId;
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

    const expiredId = await createGrant(new Date(Date.now() + 60_000));
    sql(
      `UPDATE support_access_grant SET status='Expired', expired_at=now(), expires_at=now()-interval '1 second' WHERE id='${expiredId}'`,
    );
    await page.getByRole('button', { name: 'تحديث السجل' }).click();
    await expect(page.getByText('منتهي', { exact: true })).toBeVisible();
    await expect(page.getByText('تاريخ الانتهاء', { exact: true }).last()).toBeVisible();
    await screenshot(page, (name) => info.outputPath(name), 'expired-ar');
  });

  test('covers revoke/use serialization, denial attribution, and Redis-independent read-time checks', async () => {
    const raceGrant = await createGrant(new Date(Date.now() + 60_000));
    const [revoke, use] = await Promise.all([
      fetch(`${required('US8_API_URL')}/support-access/grants/${raceGrant}/revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${required('US8_OWNER_A_TOKEN')}` },
      }),
      fetch(supportUrl(required('US8_TENANT_A_ID'), raceGrant), {
        headers: { authorization: `Bearer ${required('US8_SUPPORT_TOKEN')}` },
      }),
    ]);
    expect(revoke.status).toBe(200);
    expect([200, 403]).toContain(use.status);
    expect(
      (
        await fetch(supportUrl(required('US8_TENANT_A_ID'), raceGrant), {
          headers: { authorization: `Bearer ${required('US8_SUPPORT_TOKEN')}` },
        })
      ).status,
    ).toBe(403);

    const auditBefore = Number(
      sql(`SELECT count(*) FROM audit_event WHERE action='support_access.grant.denied'`),
    );
    expect(
      (
        await fetch(supportUrl(required('US8_TENANT_A_ID')), {
          headers: { authorization: `Bearer ${required('US8_SUPPORT_TOKEN')}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(
          supportUrl(required('US8_TENANT_A_ID'), '00000000-0000-4000-8000-000000000099'),
          {
            headers: { authorization: `Bearer ${required('US8_SUPPORT_TOKEN')}` },
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(supportUrl(required('US8_TENANT_A_ID'), lifecycleGrantId), {
          headers: { authorization: `Bearer ${required('US8_WRONG_INTERNAL_ROLE_TOKEN')}` },
        })
      ).status,
    ).toBe(403);
    expect(
      Number(sql(`SELECT count(*) FROM audit_event WHERE action='support_access.grant.denied'`)),
    ).toBe(auditBefore + 3);

    execFileSync('docker', ['pause', required('US8_REDIS_CONTAINER')]);
    try {
      expect(
        (
          await fetch(supportUrl(required('US8_TENANT_A_ID'), lifecycleGrantId), {
            headers: { authorization: `Bearer ${required('US8_SUPPORT_TOKEN')}` },
          })
        ).status,
      ).toBe(403);
    } finally {
      execFileSync('docker', ['unpause', required('US8_REDIS_CONTAINER')]);
    }
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
    const usageBefore = Number(sql('SELECT count(*) FROM support_access_usage'));
    const auditBefore = Number(
      sql(`SELECT count(*) FROM audit_event WHERE action LIKE 'support_access.%'`),
    );
    expect(
      (
        await fetch(supportUrl(required('US8_TENANT_A_ID'), lifecycleGrantId), {
          headers: { authorization: `Bearer ${required('US8_SUPPORT_TOKEN')}` },
        })
      ).status,
    ).toBe(404);
    expect(Number(sql('SELECT count(*) FROM support_access_usage'))).toBe(usageBefore);
    expect(
      Number(sql(`SELECT count(*) FROM audit_event WHERE action LIKE 'support_access.%'`)),
    ).toBe(auditBefore);
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
    await page.goto('/support-access');
    const locker = spawn('docker', [
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
      `BEGIN; LOCK TABLE support_access_grant IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(2); COMMIT;`,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await page.getByRole('button', { name: 'Refresh history' }).click();
    await expect(page.getByText(/Loading support access history/)).toBeVisible();
    await screenshot(page, (name) => info.outputPath(name), 'loading');
    await new Promise<void>((resolve, reject) => {
      locker.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`lock process ${code}`)),
      );
      locker.once('error', reject);
    });
    await expect(page.getByText(/Loading support access history/)).toHaveCount(0);
    sql('ALTER TABLE support_access_grant RENAME TO support_access_grant_error_fixture');
    try {
      await page.getByRole('button', { name: 'Refresh history' }).click();
      await expect(page.getByText(/could not be loaded/)).toBeVisible();
      await screenshot(page, (name) => info.outputPath(name), 'error');
    } finally {
      sql('ALTER TABLE support_access_grant_error_fixture RENAME TO support_access_grant');
    }
  });
});
