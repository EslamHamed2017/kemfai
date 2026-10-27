import { execFileSync } from 'node:child_process';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import ar from '../../src/locales/ar/common.json';
import en from '../../src/locales/en/common.json';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the owned T112 browser fixture`);
  return value;
};

const baseURL = required('T112_BASE_URL');
const sessionId = required('T112_SESSION_ID');

const surfaces = [
  {
    name: 'module selection',
    featureKey: 'module.module_selection',
    route: '/modules',
    navigationTestId: 'workspace-module-navigation',
    navigationPathPrefixes: ['/modules', '/workspace/modules'],
    headings: [en.moduleSelection.title, ar.moduleSelection.title],
    traces: ['.kemfai-module-shell', '[data-testid="module-selection-save"]'],
  },
  {
    name: 'onboarding checklist',
    featureKey: 'module.onboarding_checklist',
    route: '/checklist',
    navigationTestId: 'checklist-navigation',
    navigationPathPrefixes: ['/checklist'],
    headings: [en.onboardingChecklist.title, ar.onboardingChecklist.title],
    traces: ['.kemfai-checklist-shell', '[data-testid="checklist-customer"]'],
  },
  {
    name: 'support access',
    featureKey: 'module.support_access',
    route: '/support-access',
    navigationTestId: 'support-access-navigation',
    navigationPathPrefixes: ['/support-access'],
    headings: [en.supportAccess.title, ar.supportAccess.title],
    traces: ['.kemfai-support-shell', '#support-expiry'],
  },
] as const;

type Surface = (typeof surfaces)[number];
type Locale = 'en' | 'ar';

function sql(statement: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      required('T112_PG_CONTAINER'),
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      required('T112_PG_USER'),
      '-d',
      required('T112_CONTROL_DB'),
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

function setFlag(featureKey: Surface['featureKey'], enabled: boolean): void {
  const persisted = sql(
    `UPDATE feature_flag SET enabled=${enabled ? 'true' : 'false'} ` +
      `WHERE feature_key='${featureKey}' RETURNING enabled::text`,
  );
  expect(persisted).toBe(enabled ? 'true' : 'false');
}

function readFlag(featureKey: Surface['featureKey']): boolean {
  const persisted = sql(`SELECT enabled::text FROM feature_flag WHERE feature_key='${featureKey}'`);
  expect(['true', 'false']).toContain(persisted);
  return persisted === 'true';
}

async function authenticatedContext(browser: Browser, locale: Locale): Promise<BrowserContext> {
  const context = await browser.newContext({ locale: locale === 'ar' ? 'ar-AE' : 'en-US' });
  const secureURL = new URL(baseURL);
  secureURL.protocol = 'https:';
  await context.addCookies([
    {
      name: '__Host-kemfai_session',
      value: sessionId,
      url: secureURL.toString(),
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
    {
      name: 'KEMFAI_LOCALE',
      value: locale,
      url: baseURL,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  return context;
}

async function assertLocale(page: Page, locale: Locale): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
}

async function openNeutralShell(page: Page, locale: Locale, marker: string): Promise<void> {
  const response = await page.goto(`/billing?t112=${encodeURIComponent(marker)}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
  });
  expect(response?.status()).toBe(200);
  await assertLocale(page, locale);
  await expect(page.locator('main')).toBeVisible();
  const signOutButton = page.getByTestId('sign-out-button');
  await expect(signOutButton).toBeVisible();
  await expect(signOutButton).toHaveAccessibleName(
    locale === 'ar' ? ar.app.actions.signOut : en.app.actions.signOut,
  );
}

async function assertSurfaceAbsent(page: Page, surface: Surface): Promise<void> {
  await expect(page.getByTestId(surface.navigationTestId)).toHaveCount(0);
  expect(await navigationTargets(page, surface)).toEqual([]);
  for (const selector of surface.traces) await expect(page.locator(selector)).toHaveCount(0);
  for (const heading of surface.headings) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toHaveCount(0);
  }
}

async function navigationTargets(
  page: Page,
  surface: Surface,
  selector = 'a[href]',
): Promise<string[]> {
  return page.locator(selector).evaluateAll(
    (anchors, prefixes: string[]) =>
      anchors
        .map((anchor) => anchor.getAttribute('href'))
        .filter((href): href is string => href !== null)
        .filter((href) => {
          const pathname = new URL(href, window.location.origin).pathname;
          return prefixes.some(
            (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
          );
        }),
    [...surface.navigationPathPrefixes],
  );
}

async function assertChecklistModuleLinks(
  page: Page,
  locale: Locale,
  expected: number,
  marker: string,
): Promise<void> {
  const response = await page.goto(`/checklist?t112=${encodeURIComponent(marker)}-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
  });
  expect(response?.status()).toBe(200);
  await assertLocale(page, locale);
  await expect(page.getByTestId('checklist-customer')).toBeVisible();
  expect(
    await navigationTargets(page, surfaces[0], '.kemfai-checklist-shell a[href]'),
  ).toHaveLength(expected);
}

async function assertEnabledSurface(page: Page, surface: Surface, locale: Locale): Promise<void> {
  const response = await page.goto(`${surface.route}?t112=${Date.now()}`, {
    waitUntil: 'domcontentloaded',
  });
  expect(response?.status()).toBe(200);
  await assertLocale(page, locale);
  const heading = locale === 'ar' ? surface.headings[1] : surface.headings[0];
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect(page.locator(surface.traces[0])).toHaveCount(1);
}

test.describe.serial('T112 rendered feature-flag UI gating through real Next BFF and Nest', () => {
  const originalFlags = new Map<Surface['featureKey'], boolean>();

  test.beforeAll(() => {
    for (const surface of surfaces) {
      originalFlags.set(surface.featureKey, readFlag(surface.featureKey));
      setFlag(surface.featureKey, true);
    }
  });

  test.afterEach(() => {
    for (const surface of surfaces) setFlag(surface.featureKey, true);
  });

  test.afterAll(() => {
    for (const [featureKey, enabled] of originalFlags) setFlag(featureKey, enabled);
  });

  for (const locale of ['en', 'ar'] as const) {
    for (const surface of surfaces) {
      test(`${locale}: ${surface.name} cycles enabled -> disabled -> enabled with no disabled DOM or navigation`, async ({
        browser,
      }) => {
        let context = await authenticatedContext(browser, locale);
        let page = await context.newPage();
        try {
          await assertEnabledSurface(page, surface, locale);
          await openNeutralShell(page, locale, `enabled-${surface.featureKey}`);
          await expect(page.getByTestId(surface.navigationTestId)).toHaveCount(1);
          if (surface.featureKey === 'module.module_selection') {
            await assertChecklistModuleLinks(page, locale, 3, 'enabled-checklist-links');
          }

          setFlag(surface.featureKey, false);

          await openNeutralShell(page, locale, `disabled-${surface.featureKey}`);
          await assertSurfaceAbsent(page, surface);
          if (surface.featureKey === 'module.module_selection') {
            await assertChecklistModuleLinks(page, locale, 0, 'disabled-checklist-links');
            await assertSurfaceAbsent(page, surface);
          }

          const direct = await page.goto(`${surface.route}?t112=bookmark-${Date.now()}`, {
            waitUntil: 'domcontentloaded',
          });
          expect(direct?.status()).toBe(404);
          await assertSurfaceAbsent(page, surface);

          const reload = await page.reload({ waitUntil: 'domcontentloaded' });
          expect(reload?.status()).toBe(404);
          await assertSurfaceAbsent(page, surface);

          await context.close();
          context = await authenticatedContext(browser, locale);
          page = await context.newPage();
          const freshDirect = await page.goto(
            `${surface.route}?t112=fresh-disabled-${Date.now()}`,
            { waitUntil: 'domcontentloaded' },
          );
          expect(freshDirect?.status()).toBe(404);
          await assertLocale(page, locale);
          await assertSurfaceAbsent(page, surface);
          await openNeutralShell(page, locale, `fresh-shell-${surface.featureKey}`);
          await assertSurfaceAbsent(page, surface);
          if (surface.featureKey === 'module.module_selection') {
            await assertChecklistModuleLinks(page, locale, 0, 'fresh-disabled-checklist-links');
            await assertSurfaceAbsent(page, surface);
          }

          setFlag(surface.featureKey, true);
          await context.close();
          context = await authenticatedContext(browser, locale);
          page = await context.newPage();
          await assertEnabledSurface(page, surface, locale);
          await openNeutralShell(page, locale, `reenabled-${surface.featureKey}`);
          await expect(page.getByTestId(surface.navigationTestId)).toHaveCount(1);
          if (surface.featureKey === 'module.module_selection') {
            await assertChecklistModuleLinks(page, locale, 3, 'reenabled-checklist-links');
          }
        } finally {
          try {
            setFlag(surface.featureKey, true);
          } finally {
            await context.close();
          }
        }
      });
    }
  }
});
