import {
  expect,
  request,
  test,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test';

import ar from '../../src/locales/ar/common.json';
import en from '../../src/locales/en/common.json';

const configuredApiUrl = process.env.T109_API_URL;
if (!configuredApiUrl) throw new Error('T109_API_URL is required');
const API_URL: string = configuredApiUrl;

const FIXTURE_LABEL =
  'kemfai.phase12.operation=t109-parent-gates-continuation-20261025T153344Z';
const PLAN_ID = '10900000-0000-4000-8000-000000000001';
const SUBMISSION_ID = '10900000-0000-4000-8000-000000000004';
const GRANT_ID = '10900000-0000-4000-8000-000000000006';
const CUSTOMER_EMAIL = 'owner.odoo@example.test';
const CUSTOMER_COMPANY = 'Odoo Enthusiasts Trading';
const CUSTOMER_SESSION = 't109-customer-session';
const ADMIN_SESSION = 't109-admin-session';
const DENIED_SESSION = 't109-denied-session';
const MISSING_SESSION = 't109-missing-session';

type Locale = 'en' | 'ar';
type Surface =
  | 'plans'
  | 'signup'
  | 'verify-email'
  | 'mfa'
  | 'provisioning'
  | 'company-wizard'
  | 'company-settings'
  | 'billing'
  | 'modules'
  | 'checklist'
  | 'support-access'
  | 'billing-admin';
type FixtureMode = 'clean' | 'raw-success' | 'raw-error';
type FixtureScenario =
  'baseline' | 'plans-error' | 'provisioning-failed' | 'billing-error' | 'billing-upload';
type Branch =
  | 'ui-clean'
  | 'ui-branch'
  | 'ui-raw-success'
  | 'bff-success'
  | 'bff-anonymous-denial'
  | 'bff-csrf-denial'
  | 'bff-role-denial'
  | 'bff-raw-success'
  | 'bff-raw-error'
  | 'nest-public-success'
  | 'nest-public-denial'
  | 'negative-control-http'
  | 'negative-control-dom';

const EXPOSURE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['native product name', /\bodoo\b/i],
  ['company model', /\bres\.company\b/i],
  ['contact model', /\bres\.partner\b/i],
  ['native web route', /\/web(?:[/?#"'\s]|$)/i],
  ['XML-RPC transport', /\bxml[\s_-]?rpc\b|\/xmlrpc(?:\/|\b)/i],
  ['JSON-RPC transport', /\bjson[\s_-]?rpc\b|\/jsonrpc(?:\/|\b)/i],
  ['tenant database identifier', /\bkemfai_tenant_[a-z0-9_-]+\b/i],
  ['database implementation key', /\bodoo(?:DbName|_db_name)\b/i],
  ['raw RPC fault', /\b(?:faultCode|faultString|fault_code|fault_string)\b|"debug"\s*:/i],
  ['internal engine URL', /https?:\/\/[^\s"'<>]*odoo[^\s"'<>]*/i],
];
const ALLOWED_CUSTOMER_VALUES = [CUSTOMER_EMAIL, CUSTOMER_COMPANY];

function maskAllowedCustomerValues(value: string): string {
  return ALLOWED_CUSTOMER_VALUES.reduce(
    (text, allowed) => text.replaceAll(allowed, '[legitimate-customer-value]'),
    value,
  );
}

function canonicalForms(value: unknown): string[] {
  const original = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const forms = new Set<string>([original]);
  let decoded = original;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      forms.add(next);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  forms.add(
    decoded
      .replace(/\\u002f/gi, '/')
      .replace(/\\x2f/gi, '/')
      .replace(/&#0*47;|&#x0*2f;|&sol;/gi, '/'),
  );
  return [...forms].map(maskAllowedCustomerValues);
}

function assertNoExposure(value: unknown, label: string): void {
  for (const text of canonicalForms(value)) {
    for (const [kind, pattern] of EXPOSURE_PATTERNS) {
      const match = text.match(pattern);
      if (match) throw new Error(`${label} exposed ${kind}: ${match[0]}`);
    }
  }
}

async function fixtureControl(path: string, body?: unknown): Promise<void> {
  const response = await fetch(`${API_URL}/__t109/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Fixture control ${path} failed with ${response.status}`);
}

const resetFixture = () => fixtureControl('reset');
const prepareFixture = (scenario: FixtureScenario) => fixtureControl('prepare', { scenario });
const setFixtureMode = (surface: Surface, mode: FixtureMode) =>
  fixtureControl('mode', { surface, mode });

async function fixtureInfo(): Promise<{ setupScope: string }> {
  const response = await fetch(`${API_URL}/__t109/session-fixture`);
  if (!response.ok) throw new Error(`Fixture info failed with ${response.status}`);
  const value = (await response.json()) as { setupScope?: unknown };
  if (typeof value.setupScope !== 'string' || !value.setupScope) {
    throw new Error('Fixture info omitted the setup scope');
  }
  return { setupScope: value.setupScope };
}

async function seedContext(
  context: BrowserContext,
  baseURL: string,
  locale: Locale,
  customerSession = CUSTOMER_SESSION,
  internalSession = ADMIN_SESSION,
): Promise<void> {
  const secure = new URL(baseURL);
  secure.protocol = 'https:';
  await context.addCookies([
    {
      name: '__Host-kemfai_session',
      value: customerSession,
      url: secure.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
    {
      name: '__Host-kemfai_internal_session',
      value: internalSession,
      url: secure.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
    { name: 'KEMFAI_LOCALE', value: locale, url: baseURL },
  ]);
}

type HttpObservation = {
  surface: Surface;
  locale: Locale | 'language-neutral';
  branch: Branch;
  endpoint: string;
  method: string;
  url: string;
  status: number;
  contentType: string;
  bodyBytes: number;
  bodyScanned: boolean;
  headersScanned: boolean;
};

async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value)}\n`),
    contentType: 'application/json',
  });
}

type Capture = { finish: () => Promise<void> };

async function captureSurface(
  page: Page,
  baseURL: string,
  metadata: { surface: Surface; locale: Locale; branch: Branch; label: string },
  testInfo: TestInfo,
  options: { includeFixtureControls?: boolean } = {},
): Promise<Capture> {
  const origins = new Set([new URL(baseURL).origin, new URL(API_URL).origin]);
  const pending = new Set<Promise<void>>();
  const failures: string[] = [];
  const observations: HttpObservation[] = [];

  const inspect = async (route: Route) => {
    const outgoing = route.request();
    const url = new URL(outgoing.url());
    if (!origins.has(url.origin)) {
      await route.abort('blockedbyclient');
      return;
    }
    if (url.pathname.startsWith('/__t109/') && !options.includeFixtureControls) {
      await route.continue();
      return;
    }

    let response: APIResponse;
    try {
      response = await route.fetch({ maxRedirects: 0 });
    } catch (error) {
      failures.push(
        `${metadata.label} could not fetch ${outgoing.method()} ${url.pathname}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await route.abort('failed');
      return;
    }

    let body: Buffer = Buffer.alloc(0);
    try {
      body = await response.body();
    } catch (error) {
      failures.push(
        `${metadata.label} could not read ${outgoing.method()} ${url.pathname}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const headers = response.headers();
    const contentType = headers['content-type'] ?? '';
    const bodyScanned =
      /(?:json|text|html|javascript|css|xml|x-component|form-urlencoded)/i.test(contentType) ||
      ['document', 'xhr', 'fetch', 'script', 'stylesheet'].includes(outgoing.resourceType());
    try {
      assertNoExposure(outgoing.url(), `${metadata.label} request URL`);
      assertNoExposure(headers, `${metadata.label} response headers for ${url.pathname}`);
      if (bodyScanned) {
        assertNoExposure(
          body.toString('utf8'),
          `${metadata.label} HTTP ${response.status()} ${url.pathname}`,
        );
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    observations.push({
      surface: metadata.surface,
      locale: metadata.locale,
      branch: metadata.branch,
      endpoint: url.pathname,
      method: outgoing.method(),
      url: outgoing.url(),
      status: response.status(),
      contentType,
      bodyBytes: body.byteLength,
      bodyScanned,
      headersScanned: true,
    });
    await route.fulfill({ response, body });
  };

  await page.route('**/*', (route) => {
    const operation = inspect(route).finally(() => pending.delete(operation));
    pending.add(operation);
    return operation;
  });

  return {
    finish: async () => {
      await page.waitForTimeout(100);
      await page.unrouteAll({ behavior: 'wait' });
      while (pending.size > 0) await Promise.all([...pending]);
      const dom = await page.locator('html').evaluate((element) => ({
        html: element.outerHTML,
        text: (element as HTMLElement).innerText,
        attributes: [...element.querySelectorAll('*')].flatMap((child) =>
          [...child.attributes].map((attribute) => `${attribute.name}=${attribute.value}`),
        ),
      }));
      try {
        assertNoExposure(dom.text, `${metadata.label} rendered DOM text`);
        assertNoExposure(dom.attributes, `${metadata.label} rendered DOM attributes`);
        assertNoExposure(dom.html, `${metadata.label} serialized rendered DOM`);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      await attachJson(testInfo, 't109-http-observations', observations);
      expect(
        observations.some((item) => item.bodyScanned),
        `${metadata.label} captured no textual HTTP response body`,
      ).toBe(true);
      expect(failures, failures.join('\n')).toEqual([]);
    },
  };
}

async function scanApiResponse(
  response: APIResponse,
  metadata: Omit<
    HttpObservation,
    'url' | 'status' | 'contentType' | 'bodyBytes' | 'bodyScanned' | 'headersScanned'
  >,
  testInfo: TestInfo,
): Promise<string> {
  const text = await response.text();
  const headers = response.headers();
  assertNoExposure(response.url(), `${metadata.endpoint} response URL`);
  assertNoExposure(headers, `${metadata.endpoint} response headers`);
  assertNoExposure(text, `${metadata.endpoint} response body`);
  await attachJson(testInfo, 't109-http-observations', [
    {
      ...metadata,
      url: response.url(),
      status: response.status(),
      contentType: headers['content-type'] ?? '',
      bodyBytes: Buffer.byteLength(text),
      bodyScanned: true,
      headersScanned: true,
    } satisfies HttpObservation,
  ]);
  return text;
}

type Messages = typeof en;
type UiCase = {
  surface: Surface;
  path: string;
  clean: (page: Page, messages: Messages) => Promise<void>;
  prepareBranch?: () => Promise<void>;
  branchSession?: string;
  branch: (page: Page, messages: Messages) => Promise<void>;
};

const uiCases: UiCase[] = [
  {
    surface: 'plans',
    path: '/plans',
    clean: async (page) => void (await expect(page.getByTestId('plan-card')).toBeVisible()),
    prepareBranch: () => prepareFixture('plans-error'),
    branch: async (page, messages) =>
      void (await expect(page.getByText(messages.plans.error, { exact: true })).toBeVisible()),
  },
  {
    surface: 'signup',
    path: `/signup?plan=${PLAN_ID}&cycle=monthly`,
    clean: async (page, messages) => {
      await page.locator('#signup-email').fill('t109-new@example.test');
      await page.locator('#signup-password').fill('t109-strong-password');
      await page.locator('#signup-accepted-terms').check();
      await page.getByTestId('signup-submit-button').click();
      await expect(
        page.getByRole('heading', { name: messages.signup.success.title }),
      ).toBeVisible();
    },
    prepareBranch: () => setFixtureMode('signup', 'raw-error'),
    branch: async (page, messages) => {
      await page.locator('#signup-email').fill('t109-new@example.test');
      await page.locator('#signup-password').fill('t109-strong-password');
      await page.locator('#signup-accepted-terms').check();
      await page.getByTestId('signup-submit-button').click();
      await expect(
        page.getByText(messages.signup.errors.unexpected, { exact: true }),
      ).toBeVisible();
    },
  },
  {
    surface: 'verify-email',
    path: '/verify?token=t109-valid-token',
    clean: async (page, messages) =>
      void (await expect(
        page.getByRole('heading', { name: messages.verifyEmail.success.title }),
      ).toBeVisible()),
    prepareBranch: () => setFixtureMode('verify-email', 'raw-error'),
    branch: async (page) =>
      void (await expect(page.getByTestId('verify-invalid-message')).toBeVisible()),
  },
  {
    surface: 'mfa',
    path: '/mfa',
    clean: async (page, messages) => {
      await page.getByTestId('mfa-enable-button').click();
      await expect(page.getByRole('heading', { name: messages.mfa.setup.title })).toBeVisible();
      await page.getByTestId('mfa-confirm-button').click();
      await expect(page.getByRole('heading', { name: messages.mfa.complete.title })).toBeVisible();
    },
    prepareBranch: () => setFixtureMode('mfa', 'raw-error'),
    branch: async (page, messages) => {
      await page.getByTestId('mfa-enable-button').click();
      await expect(page.getByText(messages.mfa.error, { exact: true })).toBeVisible();
    },
  },
  {
    surface: 'provisioning',
    path: '/provisioning',
    clean: async (page) =>
      void (await expect(page.getByTestId('provisioning-ready')).toBeVisible()),
    prepareBranch: () => prepareFixture('provisioning-failed'),
    branch: async (page) =>
      void (await expect(page.getByTestId('provisioning-failure')).toBeVisible()),
  },
  {
    surface: 'company-wizard',
    path: '/setup-wizard',
    clean: async (page) =>
      void (await expect(page.getByTestId('setup-wizard-progress')).toBeVisible()),
    prepareBranch: () => setFixtureMode('company-wizard', 'raw-error'),
    branch: async (page) =>
      void (await expect(page.getByTestId('setup-wizard-recoverable')).toBeVisible()),
  },
  {
    surface: 'company-settings',
    path: '/company-settings',
    clean: async (page) => {
      await expect(page.getByTestId('company-settings')).toBeVisible();
      await expect
        .poll(() =>
          page
            .locator('input')
            .evaluateAll(
              (inputs, expected) =>
                inputs.some((input) => (input as HTMLInputElement).value === expected),
              CUSTOMER_COMPANY,
            ),
        )
        .toBe(true);
    },
    prepareBranch: () => setFixtureMode('company-settings', 'raw-error'),
    branch: async (page) =>
      void (await expect(page.getByTestId('company-settings-recoverable')).toBeVisible()),
  },
  {
    surface: 'billing',
    path: '/billing',
    clean: async (page) => void (await expect(page.getByTestId('billing-screen')).toBeVisible()),
    prepareBranch: () => prepareFixture('billing-error'),
    branch: async (page, messages) =>
      void (await expect(
        page.getByText(messages.billing.errors.unavailable, { exact: true }),
      ).toBeVisible()),
  },
  {
    surface: 'modules',
    path: '/modules',
    clean: async (page) =>
      void (await expect(page.getByTestId('module-selection-save')).toBeVisible()),
    prepareBranch: () => setFixtureMode('modules', 'raw-error'),
    branch: async (page, messages) =>
      void (await expect(
        page.getByText(messages.moduleSelection.loadError, { exact: true }),
      ).toBeVisible()),
  },
  {
    surface: 'checklist',
    path: '/checklist',
    clean: async (page) =>
      void (await expect(page.getByTestId('checklist-customer')).toBeVisible()),
    prepareBranch: () => setFixtureMode('checklist', 'raw-error'),
    branch: async (page, messages) =>
      void (await expect(
        page.getByText(messages.onboardingChecklist.error, { exact: true }),
      ).toBeVisible()),
  },
  {
    surface: 'support-access',
    path: '/support-access',
    clean: async (page) => void (await expect(page.locator('.kemfai-support-grant')).toBeVisible()),
    branchSession: MISSING_SESSION,
    branch: async (page, messages) =>
      void (await expect(
        page.getByText(messages.supportAccess.sessionExpired, { exact: true }),
      ).toBeVisible()),
  },
  {
    surface: 'billing-admin',
    path: '/billing-review',
    clean: async (page) => {
      await expect(page.getByTestId('billing-review')).toBeVisible();
      await expect(page.getByText(CUSTOMER_EMAIL).first()).toBeVisible();
    },
    prepareBranch: () => setFixtureMode('billing-admin', 'raw-error'),
    branch: async (page, messages) =>
      void (await expect(
        page.getByText(messages.billingReview.states.error, { exact: true }),
      ).toBeVisible()),
  },
];

test.describe('scanner controls', () => {
  for (const [label, marker] of [
    ['native name', 'Native Odoo screen'],
    ['company model', 'res.company'],
    ['contact model', 'res.partner'],
    ['native route', '/web/database/selector'],
    ['encoded native route', '%2Fweb%2Fdatabase%2Fselector'],
    ['XML-RPC', 'xmlrpc'],
    ['JSON-RPC', 'jsonrpc'],
    ['tenant database', 'kemfai_tenant_injected'],
    ['camel database key', 'odooDbName'],
    ['snake database key', 'odoo_db_name'],
    ['camel fault code', 'faultCode'],
    ['camel fault string', 'faultString'],
    ['snake fault code', 'fault_code'],
    ['snake fault string', 'fault_string'],
    ['internal URL', 'http://odoo.internal:8069'],
  ] as const) {
    test(`one-marker control detects ${label}`, async ({}, testInfo) => {
      expect(() => assertNoExposure(marker, `${label} control`)).toThrow();
      await attachJson(testInfo, 't109-control-result', {
        kind: `one-marker:${label}`,
        detected: true,
      });
    });
  }

  test('legitimate customer values are preserved rather than blanket-suppressed', () => {
    expect(() => assertNoExposure(CUSTOMER_EMAIL, 'customer email')).not.toThrow();
    expect(() => assertNoExposure(CUSTOMER_COMPANY, 'customer company')).not.toThrow();
  });

  for (const kind of ['model', 'rpc', 'database', 'route', 'fault'] as const) {
    test(`browser HTTP-body capture rejects ${kind} leak`, async ({ page, baseURL }, testInfo) => {
      await resetFixture();
      const capture = await captureSurface(
        page,
        baseURL!,
        {
          surface: 'plans',
          locale: 'en',
          branch: 'negative-control-http',
          label: `HTTP ${kind} control`,
        },
        testInfo,
        { includeFixtureControls: true },
      );
      await page.goto('/plans');
      await page.evaluate(
        async ({ apiUrl, controlKind }) => {
          await fetch(`${apiUrl}/__t109/leak/body?kind=${controlKind}`);
        },
        { apiUrl: API_URL, controlKind: kind },
      );
      await expect(capture.finish()).rejects.toThrow(/exposed/);
      await attachJson(testInfo, 't109-control-result', {
        kind: `browser-http-body:${kind}`,
        detected: true,
      });
    });
  }

  test('browser HTTP-header capture rejects a leak', async ({ page, baseURL }, testInfo) => {
    await resetFixture();
    const capture = await captureSurface(
      page,
      baseURL!,
      {
        surface: 'plans',
        locale: 'en',
        branch: 'negative-control-http',
        label: 'HTTP header control',
      },
      testInfo,
      { includeFixtureControls: true },
    );
    await page.goto('/plans');
    await page.evaluate(async (apiUrl) => {
      await fetch(`${apiUrl}/__t109/leak/header`);
    }, API_URL);
    await expect(capture.finish()).rejects.toThrow(/exposed/);
    await attachJson(testInfo, 't109-control-result', {
      kind: 'browser-http-header',
      detected: true,
    });
  });

  test('rendered DOM-attribute capture rejects a leak', async ({ page, baseURL }, testInfo) => {
    await resetFixture();
    const capture = await captureSurface(
      page,
      baseURL!,
      {
        surface: 'plans',
        locale: 'en',
        branch: 'negative-control-dom',
        label: 'DOM attribute control',
      },
      testInfo,
    );
    await page.goto('/plans');
    await expect(page.getByTestId('plan-card')).toBeVisible();
    await page.locator('main').evaluate((element) => {
      element.setAttribute('data-upstream-model', 'res.company');
    });
    await expect(capture.finish()).rejects.toThrow(/exposed/);
    await attachJson(testInfo, 't109-control-result', {
      kind: 'browser-dom-attribute',
      detected: true,
    });
  });
});

for (const locale of ['en', 'ar'] as const) {
  for (const fixture of uiCases) {
    test(`${locale} ${fixture.surface}: clean HTTP bodies and rendered DOM`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const messages = locale === 'ar' ? ar : en;
      await resetFixture();
      await seedContext(context, baseURL!, locale);
      const capture = await captureSurface(
        page,
        baseURL!,
        {
          surface: fixture.surface,
          locale,
          branch: 'ui-clean',
          label: `${locale} ${fixture.surface}`,
        },
        testInfo,
      );
      await page.goto(fixture.path);
      await fixture.clean(page, messages);
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await capture.finish();
    });

    test(`${locale} ${fixture.surface}: pertinent error or denial stays clean`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const messages = locale === 'ar' ? ar : en;
      await resetFixture();
      await fixture.prepareBranch?.();
      await seedContext(context, baseURL!, locale, fixture.branchSession ?? CUSTOMER_SESSION);
      const capture = await captureSurface(
        page,
        baseURL!,
        {
          surface: fixture.surface,
          locale,
          branch: 'ui-branch',
          label: `${locale} ${fixture.surface} branch`,
        },
        testInfo,
      );
      await page.goto(fixture.path);
      await fixture.branch(page, messages);
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await capture.finish();
    });
  }
}

for (const locale of ['en', 'ar'] as const) {
  for (const fixture of uiCases.filter(({ surface }) =>
    ['company-wizard', 'company-settings', 'modules', 'checklist'].includes(surface),
  )) {
    test(`${locale} ${fixture.surface}: raw upstream success is projected or rejected cleanly`, async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const messages = locale === 'ar' ? ar : en;
      await resetFixture();
      await setFixtureMode(fixture.surface, 'raw-success');
      await seedContext(context, baseURL!, locale);
      const capture = await captureSurface(
        page,
        baseURL!,
        {
          surface: fixture.surface,
          locale,
          branch: 'ui-raw-success',
          label: `${locale} ${fixture.surface} raw success`,
        },
        testInfo,
      );
      await page.goto(fixture.path);
      if (fixture.surface === 'checklist') await fixture.branch(page, messages);
      else await fixture.clean(page, messages);
      await capture.finish();
    });
  }
}

type PublicCase = {
  surface: Extract<Surface, 'plans' | 'signup' | 'verify-email'>;
  endpoint: string;
  expected: number;
  execute: (client: APIRequestContext) => Promise<APIResponse>;
};
const publicCases: PublicCase[] = [
  {
    surface: 'plans',
    endpoint: 'GET /public/plans',
    expected: 200,
    execute: (client) => client.get('/public/plans'),
  },
  {
    surface: 'signup',
    endpoint: 'POST /accounts/signup',
    expected: 201,
    execute: (client) =>
      client.post('/accounts/signup', {
        data: {
          email: 't109-public-success@example.test',
          password: 't109-strong-password',
          planId: PLAN_ID,
          billingCycle: 'monthly',
          acceptedTerms: true,
        },
      }),
  },
  {
    surface: 'verify-email',
    endpoint: 'POST /accounts/verify-email',
    expected: 200,
    execute: (client) =>
      client.post('/accounts/verify-email', { data: { token: 't109-valid-token' } }),
  },
  {
    surface: 'verify-email',
    endpoint: 'POST /accounts/resend-verification',
    expected: 202,
    execute: (client) =>
      client.post('/accounts/resend-verification', {
        data: { email: 'verify-odoo@example.test' },
      }),
  },
];

for (const fixture of publicCases) {
  test(`${fixture.endpoint}: actual public Nest response is clean`, async ({}, testInfo) => {
    await resetFixture();
    const client = await request.newContext({ baseURL: API_URL });
    try {
      const response = await fixture.execute(client);
      expect(response.status()).toBe(fixture.expected);
      await scanApiResponse(
        response,
        {
          surface: fixture.surface,
          locale: 'language-neutral',
          branch: 'nest-public-success',
          endpoint: fixture.endpoint,
          method: fixture.endpoint.split(' ')[0],
        },
        testInfo,
      );
    } finally {
      await client.dispose();
    }
  });
}

for (const [surface, endpoint, data, expected] of [
  ['signup', 'POST /accounts/signup', { email: 'invalid', password: 'short' }, 422],
  ['verify-email', 'POST /accounts/verify-email', { token: 'missing-token' }, 410],
  ['verify-email', 'POST /accounts/resend-verification', { email: 'invalid' }, 422],
] as const) {
  test(`${endpoint}: public validation or gone body is clean`, async ({}, testInfo) => {
    await resetFixture();
    const client = await request.newContext({ baseURL: API_URL });
    try {
      const path = endpoint.slice(endpoint.indexOf(' ') + 1);
      const response = await client.post(path, { data });
      expect(response.status()).toBe(expected);
      await scanApiResponse(
        response,
        {
          surface,
          locale: 'language-neutral',
          branch: 'nest-public-denial',
          endpoint,
          method: 'POST',
        },
        testInfo,
      );
    } finally {
      await client.dispose();
    }
  });
}

type BffCase = {
  surface: Surface;
  endpoint: string;
  expected: number;
  prepare?: FixtureScenario;
  mutation?: boolean;
  internal?: boolean;
  execute: (
    client: APIRequestContext,
    baseURL: string,
    info: { setupScope: string },
    includeOrigin?: boolean,
  ) => Promise<APIResponse>;
};

const requestHeaders = (baseURL: string, includeOrigin = true): Record<string, string> =>
  includeOrigin ? { Origin: new URL(baseURL).origin } : {};

const bffCases: BffCase[] = [
  {
    surface: 'mfa',
    endpoint: 'POST /api/accounts/mfa/enroll',
    expected: 200,
    mutation: true,
    execute: (c, b, _i, origin = true) =>
      c.post('/api/accounts/mfa/enroll', { headers: requestHeaders(b, origin) }),
  },
  {
    surface: 'mfa',
    endpoint: 'POST /api/accounts/mfa/confirm',
    expected: 200,
    mutation: true,
    execute: (c, b, _i, origin = true) =>
      c.post('/api/accounts/mfa/confirm', { headers: requestHeaders(b, origin) }),
  },
  {
    surface: 'provisioning',
    endpoint: 'GET /api/tenants/me',
    expected: 200,
    execute: (c) => c.get('/api/tenants/me'),
  },
  {
    surface: 'provisioning',
    endpoint: 'POST /api/tenants/me/provisioning-retry',
    expected: 202,
    mutation: true,
    prepare: 'provisioning-failed',
    execute: (c, b, _i, origin = true) =>
      c.post('/api/tenants/me/provisioning-retry', { headers: requestHeaders(b, origin) }),
  },
  {
    surface: 'company-wizard',
    endpoint: 'GET /api/companies/current/setup',
    expected: 200,
    execute: (c) => c.get('/api/companies/current/setup'),
  },
  {
    surface: 'company-wizard',
    endpoint: 'PUT /api/companies/current/setup',
    expected: 200,
    mutation: true,
    execute: (c, b, i, origin = true) =>
      c.put('/api/companies/current/setup', {
        headers: { ...requestHeaders(b, origin), 'x-kemfai-setup-scope': i.setupScope },
        data: { step: 'country', values: { country: 'AE' }, baseVersion: 0 },
      }),
  },
  {
    surface: 'company-wizard',
    endpoint: 'POST /api/companies/current/setup/complete',
    expected: 200,
    mutation: true,
    execute: (c, b, i, origin = true) =>
      c.post('/api/companies/current/setup/complete', {
        headers: { ...requestHeaders(b, origin), 'x-kemfai-setup-scope': i.setupScope },
      }),
  },
  {
    surface: 'company-settings',
    endpoint: 'GET /api/companies/current/settings',
    expected: 200,
    execute: (c) => c.get('/api/companies/current/settings'),
  },
  {
    surface: 'company-settings',
    endpoint: 'PUT /api/companies/current/settings',
    expected: 200,
    mutation: true,
    execute: (c, b, _i, origin = true) =>
      c.put('/api/companies/current/settings', {
        headers: requestHeaders(b, origin),
        data: { values: { trade_name: CUSTOMER_COMPANY } },
      }),
  },
  {
    surface: 'billing',
    endpoint: 'GET /api/billing/subscription',
    expected: 200,
    execute: (c) => c.get('/api/billing/subscription'),
  },
  {
    surface: 'billing',
    endpoint: 'GET /api/billing/payment-submissions',
    expected: 200,
    execute: (c) => c.get('/api/billing/payment-submissions'),
  },
  {
    surface: 'billing',
    endpoint: 'POST /api/billing/payment-submissions',
    expected: 201,
    mutation: true,
    prepare: 'billing-upload',
    execute: (c, b, _i, origin = true) =>
      c.post('/api/billing/payment-submissions', {
        headers: requestHeaders(b, origin),
        multipart: {
          bankReference: `BANK-T109-${Date.now()}`,
          proofFile: {
            name: 'proof.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from('%PDF-1.7\nT109 proof\n%%EOF\n'),
          },
        },
      }),
  },
  {
    surface: 'modules',
    endpoint: 'GET /api/modules',
    expected: 200,
    execute: (c) => c.get('/api/modules'),
  },
  {
    surface: 'modules',
    endpoint: 'PUT /api/modules/selection',
    expected: 200,
    mutation: true,
    execute: (c, b, _i, origin = true) =>
      c.put('/api/modules/selection', {
        headers: requestHeaders(b, origin),
        data: { featureKeys: ['module.accounting'] },
      }),
  },
  {
    surface: 'checklist',
    endpoint: 'GET /api/onboarding/checklist',
    expected: 200,
    execute: (c) => c.get('/api/onboarding/checklist'),
  },
  {
    surface: 'support-access',
    endpoint: 'GET /api/support-access/grants',
    expected: 200,
    execute: (c) => c.get('/api/support-access/grants'),
  },
  {
    surface: 'support-access',
    endpoint: 'POST /api/support-access/grants',
    expected: 201,
    mutation: true,
    execute: (c, b, _i, origin = true) =>
      c.post('/api/support-access/grants', {
        headers: requestHeaders(b, origin),
        data: { expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
      }),
  },
  {
    surface: 'support-access',
    endpoint: 'POST /api/support-access/grants/:grantId/revoke',
    expected: 200,
    mutation: true,
    execute: (c, b, _i, origin = true) =>
      c.post(`/api/support-access/grants/${GRANT_ID}/revoke`, {
        headers: requestHeaders(b, origin),
      }),
  },
  {
    surface: 'billing-admin',
    endpoint: 'GET /api/internal/billing/review-queue',
    expected: 200,
    internal: true,
    execute: (c) => c.get('/api/internal/billing/review-queue'),
  },
  {
    surface: 'billing-admin',
    endpoint: 'POST /api/internal/billing/payment-submissions/:submissionId/approve',
    expected: 200,
    mutation: true,
    internal: true,
    execute: (c, b, _i, origin = true) =>
      c.post(`/api/internal/billing/payment-submissions/${SUBMISSION_ID}/approve`, {
        headers: requestHeaders(b, origin),
      }),
  },
  {
    surface: 'billing-admin',
    endpoint: 'POST /api/internal/billing/payment-submissions/:submissionId/reject',
    expected: 200,
    mutation: true,
    internal: true,
    execute: (c, b, _i, origin = true) =>
      c.post(`/api/internal/billing/payment-submissions/${SUBMISSION_ID}/reject`, {
        headers: requestHeaders(b, origin),
        data: { reason: 'Reference did not match' },
      }),
  },
  {
    surface: 'billing-admin',
    endpoint: 'POST /api/internal/billing/payment-submissions/:submissionId/request-more-info',
    expected: 200,
    mutation: true,
    internal: true,
    execute: (c, b, _i, origin = true) =>
      c.post(`/api/internal/billing/payment-submissions/${SUBMISSION_ID}/request-more-info`, {
        headers: requestHeaders(b, origin),
        data: { details: 'Upload a complete receipt' },
      }),
  },
];

for (const fixture of bffCases) {
  test(`${fixture.endpoint}: real Next BFF and Nest success body is clean`, async ({
    context,
    baseURL,
  }, testInfo) => {
    await resetFixture();
    if (fixture.prepare) await prepareFixture(fixture.prepare);
    await seedContext(context, baseURL!, 'en');
    const response = await fixture.execute(context.request, baseURL!, await fixtureInfo());
    expect(response.status(), fixture.endpoint).toBe(fixture.expected);
    const text = await scanApiResponse(
      response,
      {
        surface: fixture.surface,
        locale: 'language-neutral',
        branch: 'bff-success',
        endpoint: fixture.endpoint,
        method: fixture.endpoint.split(' ')[0],
      },
      testInfo,
    );
    if (fixture.endpoint === 'GET /api/companies/current/settings')
      expect(text).toContain(CUSTOMER_COMPANY);
    if (fixture.endpoint === 'GET /api/internal/billing/review-queue')
      expect(text).toContain(CUSTOMER_EMAIL);
  });

  test(`${fixture.endpoint}: anonymous denial body is clean`, async ({ baseURL }, testInfo) => {
    await resetFixture();
    if (fixture.prepare) await prepareFixture(fixture.prepare);
    const anonymous = await request.newContext({ baseURL });
    try {
      const response = await fixture.execute(anonymous, baseURL!, await fixtureInfo());
      expect(response.status(), fixture.endpoint).toBe(401);
      await scanApiResponse(
        response,
        {
          surface: fixture.surface,
          locale: 'language-neutral',
          branch: 'bff-anonymous-denial',
          endpoint: fixture.endpoint,
          method: fixture.endpoint.split(' ')[0],
        },
        testInfo,
      );
    } finally {
      await anonymous.dispose();
    }
  });

  if (fixture.mutation) {
    test(`${fixture.endpoint}: CSRF denial body is clean`, async ({ baseURL }, testInfo) => {
      await resetFixture();
      if (fixture.prepare) await prepareFixture(fixture.prepare);
      const cookie = fixture.internal
        ? `__Host-kemfai_internal_session=${ADMIN_SESSION}`
        : `__Host-kemfai_session=${CUSTOMER_SESSION}`;
      const client = await request.newContext({ baseURL, extraHTTPHeaders: { Cookie: cookie } });
      try {
        const response = await fixture.execute(client, baseURL!, await fixtureInfo(), false);
        expect(response.status(), fixture.endpoint).toBe(403);
        await scanApiResponse(
          response,
          {
            surface: fixture.surface,
            locale: 'language-neutral',
            branch: 'bff-csrf-denial',
            endpoint: fixture.endpoint,
            method: fixture.endpoint.split(' ')[0],
          },
          testInfo,
        );
      } finally {
        await client.dispose();
      }
    });
  }
}

for (const fixture of bffCases.filter(({ internal }) => internal)) {
  test(`${fixture.endpoint}: wrong internal role denial body is clean`, async ({
    baseURL,
  }, testInfo) => {
    await resetFixture();
    const client = await request.newContext({
      baseURL,
      extraHTTPHeaders: { Cookie: `__Host-kemfai_internal_session=${DENIED_SESSION}` },
    });
    try {
      const response = await fixture.execute(client, baseURL!, await fixtureInfo());
      expect(response.status(), fixture.endpoint).toBe(403);
      await scanApiResponse(
        response,
        {
          surface: fixture.surface,
          locale: 'language-neutral',
          branch: 'bff-role-denial',
          endpoint: fixture.endpoint,
          method: fixture.endpoint.split(' ')[0],
        },
        testInfo,
      );
    } finally {
      await client.dispose();
    }
  });
}

const odooBffCases = bffCases.filter(({ endpoint }) =>
  [
    'GET /api/companies/current/setup',
    'PUT /api/companies/current/setup',
    'POST /api/companies/current/setup/complete',
    'GET /api/companies/current/settings',
    'PUT /api/companies/current/settings',
    'GET /api/modules',
    'PUT /api/modules/selection',
    'GET /api/onboarding/checklist',
  ].includes(endpoint),
);

for (const fixture of odooBffCases) {
  for (const mode of ['raw-success', 'raw-error'] as const) {
    test(`${fixture.endpoint}: ${mode} adapter payload cannot cross Next BFF`, async ({
      context,
      baseURL,
    }, testInfo) => {
      await resetFixture();
      await setFixtureMode(fixture.surface, mode);
      await seedContext(context, baseURL!, 'en');
      const response = await fixture.execute(context.request, baseURL!, await fixtureInfo());
      const rawSuccessRejected =
        mode === 'raw-success' &&
        (fixture.surface === 'checklist' || fixture.endpoint === 'PUT /api/modules/selection');
      expect(response.status(), `${fixture.endpoint} ${mode}`).toBe(
        mode === 'raw-error' || rawSuccessRejected ? 500 : fixture.expected,
      );
      await scanApiResponse(
        response,
        {
          surface: fixture.surface,
          locale: 'language-neutral',
          branch: mode === 'raw-success' ? 'bff-raw-success' : 'bff-raw-error',
          endpoint: fixture.endpoint,
          method: fixture.endpoint.split(' ')[0],
        },
        testInfo,
      );
    });
  }
}

test.afterAll(() => {
  expect(process.env.T109_FIXTURE_LABEL).toBe(FIXTURE_LABEL);
});
