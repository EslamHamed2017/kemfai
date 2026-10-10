import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import en from '../../src/locales/en/common.json';
import ar from '../../src/locales/ar/common.json';

/**
 * T052 genuine acceptance path. Nothing in this file mocks or routes network traffic:
 * scripts/test_t052_live_browser.sh supplies two label-owned users, tenant databases,
 * companies, country-validation rules, and industries, then starts the real Keycloak,
 * Next.js BFF, NestJS API, and Odoo services.
 */

type Locale = 'en' | 'ar';
type FieldKey =
  | 'country'
  | 'legal_name'
  | 'trade_name'
  | 'base_currency'
  | 'fiscal_year_start_month'
  | 'fiscal_year_start_day'
  | 'vat_tax_registration'
  | 'industry'
  | 'accounting_setup_template';

const STEP_IDS = [
  'country',
  'identity',
  'currency',
  'fiscal_year',
  'vat_tax',
  'industry',
  'accounting_setup',
] as const;

// The harness changes only this exact line in a disposable copy for its expected-RED
// negative control. The submitted source remains the real expected value.
const EXPECTED_LAST_PROGRESS_ID = 'accounting_setup';
const NEGATIVE_CONTROL_MARKER = 'T052_NEGATIVE_CONTROL_EXPECTED';

const messages = { en, ar } as const;
const localeDirection = { en: 'ltr', ar: 'rtl' } as const;
const SESSION_COOKIE_NAMES = ['__Host-kemfai_session', 'kemfai_session'];
const ODOO_EXPOSURE = /(?:\bodoo\b|\/web(?:\/|$)|\/jsonrpc\b)/i;

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the T052 live browser harness`);
  return value;
};

interface Flow {
  locale: Locale;
  page: Page;
  context: BrowserContext;
  requests: string[];
  legalName: string;
  tradeName: string;
  country: string;
  currency: string;
  vat: string;
  industryId: string;
  dbEnv: string;
  companyEnv: string;
  layouts: Partial<Record<(typeof STEP_IDS)[number], StepLayout>>;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface StepLayout {
  field: Box;
  progress: Box;
  actions: [number, number, number];
  fieldDirection: string;
  progressDirection: string;
  directionalIconTransforms: string[];
}

async function realLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/auth/login?returnTo=%2Fsetup-wizard');
  await page.waitForSelector('#username', { timeout: 15_000 });
  await page.fill('#username', email);
  await page.fill('#password', password);
  await page.click('#kc-login');
  await page.waitForURL('**/mfa', { timeout: 15_000 });
  await page.goto('/setup-wizard');
  await page.waitForURL('**/setup-wizard', { timeout: 15_000 });
}

async function setLocaleCookie(context: BrowserContext, locale: Locale): Promise<void> {
  await context.addCookies([
    { name: 'KEMFAI_LOCALE', value: locale, url: required('T052_BASE_URL') },
  ]);
}

async function assertLocale(
  page: Page,
  locale: Locale,
  expectedHeading = messages[locale].setupWizard.title,
): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.locator('html')).toHaveAttribute('dir', localeDirection[locale]);
  await expect(page.locator('main')).toHaveAttribute('dir', localeDirection[locale]);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(expectedHeading);
  expect(await page.locator('main').evaluate((element) => getComputedStyle(element).direction)).toBe(
    localeDirection[locale],
  );
}

async function assertAxeClean(page: Page, locale: Locale, step: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations,
    `${locale}/${step} axe violations:\n${JSON.stringify(results.violations, null, 2)}`,
  ).toEqual([]);
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, `${locale}/${step} must not overflow horizontally`).toBeLessThanOrEqual(
    overflow.clientWidth,
  );
}

async function captureStepLayout(page: Page): Promise<StepLayout> {
  const representativeField = page.getByTestId('setup-wizard-fieldset').locator('input, select').first();
  const activeProgress = page.getByTestId('setup-wizard-progress').locator('[aria-current="step"]');
  const actionLocators = [
    page.getByTestId('setup-wizard-back'),
    page.getByTestId('setup-wizard-pause'),
    page.getByTestId('setup-wizard-next'),
  ] as const;
  const [field, progress, ...actionBoxes] = await Promise.all([
    representativeField.boundingBox(),
    activeProgress.boundingBox(),
    ...actionLocators.map((locator) => locator.boundingBox()),
  ]);
  expect(field, 'representative form field must have layout geometry').not.toBeNull();
  expect(progress, 'active progress control must have layout geometry').not.toBeNull();
  actionBoxes.forEach((box, index) =>
    expect(box, `wizard action ${index} must have layout geometry`).not.toBeNull(),
  );

  const directionalIcons = page.locator('[data-directional-icon]');
  const directionalIconTransforms = await directionalIcons.evaluateAll((icons) =>
    icons.map((icon) => getComputedStyle(icon).transform),
  );
  const centers = actionBoxes.map((box) => box!.x + box!.width / 2) as [number, number, number];

  return {
    field: field!,
    progress: progress!,
    actions: centers,
    fieldDirection: await representativeField.evaluate((element) => getComputedStyle(element).direction),
    progressDirection: await activeProgress.evaluate((element) => getComputedStyle(element).direction),
    directionalIconTransforms,
  };
}

async function assertStepSurface(flow: Flow, step: (typeof STEP_IDS)[number]): Promise<void> {
  await assertAxeClean(flow.page, flow.locale, step);
  flow.layouts[step] = await captureStepLayout(flow.page);
}

function assertMirroredLayouts(english: Flow, arabic: Flow): void {
  const viewportWidth = 1280;
  const tolerance = 3;
  const mirroredX = (box: Box) => viewportWidth - box.x - box.width;

  for (const step of STEP_IDS) {
    const ltr = english.layouts[step];
    const rtl = arabic.layouts[step];
    expect(ltr, `missing English geometry for ${step}`).toBeDefined();
    expect(rtl, `missing Arabic geometry for ${step}`).toBeDefined();

    expect(Math.abs(ltr!.field.x - mirroredX(rtl!.field)), `${step} form field must mirror`).toBeLessThanOrEqual(
      tolerance,
    );
    expect(
      Math.abs(ltr!.progress.x - mirroredX(rtl!.progress)),
      `${step} active progress control must mirror`,
    ).toBeLessThanOrEqual(tolerance);
    expect(ltr!.fieldDirection).toBe('ltr');
    expect(rtl!.fieldDirection).toBe('rtl');
    expect(ltr!.progressDirection).toBe('ltr');
    expect(rtl!.progressDirection).toBe('rtl');

    expect(ltr!.actions[0]).toBeLessThan(ltr!.actions[1]);
    expect(ltr!.actions[1]).toBeLessThan(ltr!.actions[2]);
    expect(rtl!.actions[0]).toBeGreaterThan(rtl!.actions[1]);
    expect(rtl!.actions[1]).toBeGreaterThan(rtl!.actions[2]);

    expect(rtl!.directionalIconTransforms).toHaveLength(ltr!.directionalIconTransforms.length);
    if (ltr!.directionalIconTransforms.length === 0) continue;
    rtl!.directionalIconTransforms.forEach((transform, index) => {
      expect(transform).not.toBe(ltr!.directionalIconTransforms[index]);
      expect(transform).toMatch(/^matrix\(-1,\s*0,\s*0,\s*1|scaleX\(-1\)/);
    });
  }
}

async function assertProgress(page: Page, locale: Locale, activeStep: string): Promise<void> {
  const progress = page.getByTestId('setup-wizard-progress');
  await expect(progress).toBeVisible();
  await expect(progress.getByRole('button')).toHaveCount(STEP_IDS.length);
  expect(await progress.getByRole('button').allTextContents()).toEqual(
    STEP_IDS.map((step) => messages[locale].setupWizard.steps[step]),
  );
  await expect(page.getByTestId(`setup-wizard-step-${activeStep}`)).toHaveAttribute('aria-current', 'step');

  // This assertion is intentionally early and mutation-free. The harness's disposable
  // RED copy replaces EXPECTED_LAST_PROGRESS_ID with a missing id and must fail here
  // with the exact marker before it can write any wizard value.
  expect(
    await page.getByTestId(`setup-wizard-step-${EXPECTED_LAST_PROGRESS_ID}`).count(),
    NEGATIVE_CONTROL_MARKER,
  ).toBe(1);
}

async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  expect(
    await target.evaluate((element) => element === document.activeElement),
    'control must be reachable by sequential keyboard navigation',
  ).toBe(true);
}

async function keyboardActivate(page: Page, target: Locator): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press('Enter');
}

async function fillText(page: Page, locale: Locale, field: FieldKey, value: string) {
  const input = page.getByLabel(messages[locale].setupWizard.fields[field].label);
  await input.fill(value);
  return input;
}

async function switchLocaleWithUnsavedIdentity(flow: Flow): Promise<void> {
  const opposite: Locale = flow.locale === 'en' ? 'ar' : 'en';
  const current = messages[flow.locale].setupWizard.fields;
  await flow.page.getByLabel(current.legal_name.label).fill(flow.legalName);
  await flow.page.getByLabel(current.trade_name.label).fill(flow.tradeName);

  await keyboardActivate(flow.page, flow.page.getByTestId('locale-switcher'));
  await assertLocale(flow.page, opposite);
  await expect(flow.page.getByLabel(messages[opposite].setupWizard.fields.legal_name.label)).toHaveValue(
    flow.legalName,
  );
  await expect(flow.page.getByLabel(messages[opposite].setupWizard.fields.trade_name.label)).toHaveValue(
    flow.tradeName,
  );
  await assertProgress(flow.page, opposite, 'identity');
  await assertAxeClean(flow.page, opposite, 'identity-after-unsaved-switch');

  await keyboardActivate(flow.page, flow.page.getByTestId('locale-switcher'));
  await assertLocale(flow.page, flow.locale);
  await expect(flow.page.getByLabel(messages[flow.locale].setupWizard.fields.legal_name.label)).toHaveValue(
    flow.legalName,
  );
  await expect(flow.page.getByLabel(messages[flow.locale].setupWizard.fields.trade_name.label)).toHaveValue(
    flow.tradeName,
  );
}

async function saveAndExpectStep(flow: Flow, nextStep: string): Promise<void> {
  await keyboardActivate(flow.page, flow.page.getByTestId('setup-wizard-next'));
  await expect(flow.page.getByTestId(`setup-wizard-step-${nextStep}`)).toHaveAttribute(
    'aria-current',
    'step',
    { timeout: 15_000 },
  );
  await assertProgress(flow.page, flow.locale, nextStep);
  await assertStepSurface(flow, nextStep as (typeof STEP_IDS)[number]);
}

async function odooReadCompany(flow: Flow): Promise<Record<string, unknown>> {
  const odooBase = required('T052_ODOO_BASE');
  const db = required(flow.dbEnv);
  const companyId = Number(required(flow.companyEnv));
  const login = required('T052_ODOO_ADMIN_LOGIN');
  const password = required('T052_ODOO_ADMIN_PASSWORD');

  const rpc = async (service: string, method: string, args: unknown[]): Promise<unknown> => {
    const response = await fetch(`${odooBase}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: 1 }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? 'Odoo RPC failed');
    return body.result;
  };

  const uid = (await rpc('common', 'login', [db, login, password])) as number;
  const rows = (await rpc('object', 'execute_kw', [
    db,
    uid,
    password,
    'res.company',
    'read',
    [[companyId], [
      'country',
      'legal_name',
      'trade_name',
      'base_currency',
      'fiscal_year_start_month',
      'fiscal_year_start_day',
      'vat_tax_registration',
      'industry',
      'accounting_setup_template',
      'setup_complete',
    ]],
  ])) as Array<Record<string, unknown>>;
  return rows[0];
}

async function completeFlow(flow: Flow): Promise<void> {
  await assertLocale(flow.page, flow.locale);
  await assertProgress(flow.page, flow.locale, 'country');
  await assertStepSurface(flow, 'country');

  await fillText(flow.page, flow.locale, 'country', flow.country);
  await saveAndExpectStep(flow, 'identity');

  await switchLocaleWithUnsavedIdentity(flow);
  await saveAndExpectStep(flow, 'currency');

  // Acceptance 3.3 + FR-013: Back is reached and activated by Tab/Enter, saved values
  // survive, remain editable, and the forward control works from the keyboard too.
  await keyboardActivate(flow.page, flow.page.getByTestId('setup-wizard-back'));
  await expect(flow.page.getByTestId('setup-wizard-step-identity')).toHaveAttribute('aria-current', 'step');
  const legalName = flow.page.getByLabel(messages[flow.locale].setupWizard.fields.legal_name.label);
  await expect(legalName).toHaveValue(flow.legalName);
  await legalName.fill(`${flow.legalName} Updated`);
  flow.legalName = `${flow.legalName} Updated`;
  await saveAndExpectStep(flow, 'currency');

  await fillText(flow.page, flow.locale, 'base_currency', flow.currency);
  await saveAndExpectStep(flow, 'fiscal_year');

  await flow.page
    .getByLabel(messages[flow.locale].setupWizard.fields.fiscal_year_start_month.label)
    .selectOption('1');
  await fillText(flow.page, flow.locale, 'fiscal_year_start_day', '1');
  await saveAndExpectStep(flow, 'vat_tax');

  await fillText(flow.page, flow.locale, 'vat_tax_registration', flow.vat);
  await saveAndExpectStep(flow, 'industry');

  await fillText(flow.page, flow.locale, 'industry', flow.industryId);
  await saveAndExpectStep(flow, 'accounting_setup');

  await flow.page
    .getByLabel(messages[flow.locale].setupWizard.fields.accounting_setup_template.label)
    .selectOption('standard');
  await keyboardActivate(flow.page, flow.page.getByTestId('setup-wizard-next'));
  await expect(flow.page.getByTestId('setup-wizard-complete')).toContainText(
    messages[flow.locale].setupWizard.complete.title,
    { timeout: 15_000 },
  );
  await assertLocale(flow.page, flow.locale, messages[flow.locale].setupWizard.complete.title);
  await assertAxeClean(flow.page, flow.locale, 'completed');

  const authoritative = await flow.page.evaluate(async () => {
    const response = await fetch('/api/companies/current/setup', { cache: 'no-store' });
    if (!response.ok) throw new Error(`authoritative setup read failed with HTTP ${response.status}`);
    return response.json() as Promise<{ setupComplete: boolean; values: Record<string, unknown> }>;
  });
  expect(authoritative.setupComplete).toBe(true);
  expect(authoritative.values).toMatchObject({
    country: flow.country,
    legal_name: flow.legalName,
    trade_name: flow.tradeName,
    base_currency: flow.currency,
    fiscal_year_start_month: '1',
    fiscal_year_start_day: 1,
    vat_tax_registration: flow.vat,
    industry: Number(flow.industryId),
    accounting_setup_template: 'standard',
  });

  const company = await odooReadCompany(flow);
  expect(company.setup_complete).toBe(true);
  expect(company.legal_name).toBe(flow.legalName);
  expect(company.trade_name).toBe(flow.tradeName);
  expect(company.fiscal_year_start_month).toBe('1');
  expect(company.fiscal_year_start_day).toBe(1);
  expect(company.vat_tax_registration).toBe(flow.vat);
  expect(company.accounting_setup_template).toBe('standard');
}

test('T052 live: full fixed-order wizard completes in English/LTR and Arabic/RTL with real bidirectional unsaved-input switching, keyboard navigation, and zero axe violations', async ({
  browser,
}) => {
  const englishContext = await browser.newContext();
  const arabicContext = await browser.newContext();
  await setLocaleCookie(englishContext, 'en');
  await setLocaleCookie(arabicContext, 'ar');
  const englishPage = await englishContext.newPage();
  const arabicPage = await arabicContext.newPage();
  const englishRequests: string[] = [];
  const arabicRequests: string[] = [];
  englishPage.on('request', (request) => englishRequests.push(request.url()));
  arabicPage.on('request', (request) => arabicRequests.push(request.url()));

  const english: Flow = {
    locale: 'en',
    page: englishPage,
    context: englishContext,
    requests: englishRequests,
    legalName: 'T052 English Company',
    tradeName: 'T052 English Trade',
    country: 'AE',
    currency: 'AED',
    vat: '100000000000003',
    industryId: required('T052_ALPHA_INDUSTRY_ID'),
    dbEnv: 'T052_ALPHA_DB',
    companyEnv: 'T052_ALPHA_COMPANY_ID',
    layouts: {},
  };
  const arabic: Flow = {
    locale: 'ar',
    page: arabicPage,
    context: arabicContext,
    requests: arabicRequests,
    legalName: 'شركة تي 052 العربية',
    tradeName: 'تجارة تي 052',
    country: 'AE',
    currency: 'AED',
    vat: '200000000000006',
    industryId: required('T052_BETA_INDUSTRY_ID'),
    dbEnv: 'T052_BETA_DB',
    companyEnv: 'T052_BETA_COMPANY_ID',
    layouts: {},
  };

  try {
    await realLogin(englishPage, required('T052_ALPHA_EMAIL'), required('T052_ALPHA_PASSWORD'));
    await realLogin(arabicPage, required('T052_BETA_EMAIL'), required('T052_BETA_PASSWORD'));

    const [englishCookies, arabicCookies] = await Promise.all([
      englishContext.cookies(),
      arabicContext.cookies(),
    ]);
    expect(englishCookies.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name))).toBe(true);
    expect(arabicCookies.some((cookie) => SESSION_COOKIE_NAMES.includes(cookie.name))).toBe(true);

    // Keep both genuine stacks active together so each locale is proven against its own
    // tenant/database. The flows are sequential only to keep failure evidence precise.
    await completeFlow(english);
    await completeFlow(arabic);
    assertMirroredLayouts(english, arabic);

    const frontendOrigin = new URL(required('T052_BASE_URL')).origin;
    for (const flow of [english, arabic]) {
      expect(flow.page.url().startsWith(frontendOrigin)).toBe(true);
      expect(await flow.page.locator('body').innerText()).not.toMatch(ODOO_EXPOSURE);
      for (const requestUrl of flow.requests) {
        const url = new URL(requestUrl);
        if (url.origin === frontendOrigin) expect(url.pathname).not.toMatch(ODOO_EXPOSURE);
      }
    }
  } finally {
    await englishContext.close();
    await arabicContext.close();
  }
});
