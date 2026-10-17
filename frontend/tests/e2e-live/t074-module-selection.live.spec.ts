import { execFileSync } from 'node:child_process';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

function sql(statement: string): string {
  return execFileSync('docker', [
    'exec', required('T074_PG_CONTAINER'), 'psql', '-U', required('T074_PG_USER'),
    '-d', required('T074_CONTROL_DB'), '-X', '-q', '-t', '-A', '-c', statement,
  ], { encoding: 'utf8' }).trim();
}

async function authenticatedPage(browser: Browser, session: string): Promise<{context: BrowserContext; page: Page}> {
  const context = await browser.newContext({ locale: 'en-US' });
  const url = new URL(required('T074_BASE_URL')); url.protocol = 'https:';
  await context.addCookies([{ name: '__Host-kemfai_session', value: session, url: url.toString(), httpOnly: true, secure: true, sameSite: 'Lax' }]);
  return { context, page: await context.newPage() };
}

test.describe.serial('T074 owned real module-selection journey', () => {
  test('save, revisit, CSRF, Odoo persistence, audit, tenant isolation, denial, revocation, flag and trial controls', async ({ browser }, testInfo) => {
    const alpha = await authenticatedPage(browser, required('T074_SESSION_A'));
    await alpha.page.goto('/modules');
    await expect(alpha.page.getByRole('heading', { name: 'Choose workspace modules' })).toBeVisible();
    await expect(alpha.page.getByLabel('Inventory')).toBeDisabled();
    await expect(alpha.page.getByText(required('T074_UPGRADE_PLAN'))).toBeVisible();
    await alpha.page.locator('label[for="select-module.accounting"]').click();
    await alpha.page.getByTestId('module-selection-save').click();
    await expect(alpha.page.getByTestId('module-selection-success')).toBeVisible();
    await alpha.page.reload();
    await expect(alpha.page.getByLabel('Accounting')).toBeChecked();
    await expect(alpha.page.getByTestId('workspace-module-navigation').getByRole('link', { name: 'Accounting' })).toBeVisible();
    expect(await new AxeBuilder({ page: alpha.page }).analyze()).toMatchObject({ violations: [] });
    expect(await alpha.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await alpha.page.screenshot({ path: testInfo.outputPath('en-desktop.png'), fullPage: true });
    await alpha.page.setViewportSize({ width: 390, height: 844 });
    await alpha.page.screenshot({ path: testInfo.outputPath('en-mobile.png'), fullPage: true });
    await alpha.page.getByRole('button', { name: 'العربية' }).click();
    await expect(alpha.page.locator('main')).toHaveAttribute('dir', 'rtl');
    expect(await new AxeBuilder({ page: alpha.page }).analyze()).toMatchObject({ violations: [] });
    await alpha.page.setViewportSize({ width: 1280, height: 900 });
    await alpha.page.screenshot({ path: testInfo.outputPath('ar-desktop.png'), fullPage: true });
    await alpha.page.setViewportSize({ width: 390, height: 844 });
    await alpha.page.screenshot({ path: testInfo.outputPath('ar-mobile.png'), fullPage: true });
    await alpha.page.getByRole('button', { name: 'English' }).click();
    await expect(alpha.page.locator('main')).toHaveAttribute('dir', 'ltr');

    const foreign = await alpha.page.request.put('/api/modules/selection', {
      headers: { origin: 'https://foreign.example.invalid' }, data: { featureKeys: ['module.accounting'] },
    });
    expect(foreign.status()).toBe(403);
    expect(sql("SELECT count(*) FROM audit_event WHERE action='modules.selection.changed' AND tenant_id='" + required('T074_TENANT_A_ID') + "';")).toBe('1');

    const beta = await authenticatedPage(browser, required('T074_SESSION_B'));
    await beta.page.goto('/modules');
    await expect(beta.page.getByLabel('Accounting')).not.toBeChecked();
    await beta.context.close();

    sql("UPDATE plan_feature_entitlement SET enabled=false WHERE plan_id='" + required('T074_PLAN_A_ID') + "' AND feature_key='module.accounting';");
    await alpha.page.reload();
    await expect(alpha.page.getByTestId('workspace-module-navigation').getByRole('link', { name: 'Accounting' })).toHaveCount(0);
    expect((await alpha.page.goto('/workspace/modules/module.accounting'))?.status()).toBe(404);

    sql("UPDATE feature_flag SET enabled=false WHERE feature_key='module.module_selection';");
    expect((await alpha.page.goto('/modules'))?.status()).toBe(404);
    sql("UPDATE feature_flag SET enabled=true WHERE feature_key='module.module_selection'; UPDATE plan_feature_entitlement SET enabled=true WHERE plan_id='" + required('T074_PLAN_A_ID') + "' AND feature_key='module.accounting'; UPDATE subscription SET status='PendingActivation', current_period_end=current_date-30 WHERE tenant_id='" + required('T074_TENANT_A_ID') + "'; UPDATE tenant SET ready_at=current_date-30 WHERE id='" + required('T074_TENANT_A_ID') + "';");
    await alpha.page.goto('/modules');
    await expect(alpha.page.getByText("We couldn't load modules. Try again.")).toBeVisible();
    await alpha.context.close();
  });
});
