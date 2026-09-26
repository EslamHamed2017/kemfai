import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export const VIEWPORT = { width: 1280, height: 720 } as const;

export type Locale = 'en' | 'ar';

const LOCALE_COOKIE_NAME = 'KEMFAI_LOCALE';
const MIRROR_TOLERANCE_PX = 3;

/**
 * Opens a fresh, isolated context/page pinned to `locale` (via the
 * `KEMFAI_LOCALE` cookie the app reads server-side — see
 * src/lib/i18n/locale.ts) and to the fixed 1280x720 viewport the arbiter
 * resolution mandates for all T030 geometry assertions.
 */
export async function openLocalePage(
  browser: Browser,
  baseURL: string,
  locale: Locale,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: VIEWPORT, baseURL });
  await context.addCookies([{ name: LOCALE_COOKIE_NAME, value: locale, url: baseURL }]);
  const page = await context.newPage();
  return { context, page };
}

/**
 * Core geometry contract from the arbiter resolution: an element's EN
 * bounding box must equal its AR bounding box reflected across the
 * viewport's vertical centerline, and each locale's computed `direction`
 * must match. A `dir` attribute or overflow assertion alone is
 * insufficient — this reads live layout geometry instead.
 */
export async function assertMirrored(
  ltrLocator: Locator,
  rtlLocator: Locator,
  viewportWidth: number,
): Promise<void> {
  const [ltrBox, rtlBox] = await Promise.all([ltrLocator.boundingBox(), rtlLocator.boundingBox()]);
  expect(ltrBox, 'expected LTR element to have a bounding box').not.toBeNull();
  expect(rtlBox, 'expected RTL element to have a bounding box').not.toBeNull();
  const ltr = ltrBox!;
  const rtl = rtlBox!;

  const mirroredRtlX = viewportWidth - rtl.x - rtl.width;
  expect(Math.abs(ltr.x - mirroredRtlX)).toBeLessThanOrEqual(MIRROR_TOLERANCE_PX);

  const [ltrDirection, rtlDirection] = await Promise.all([
    ltrLocator.evaluate((el) => getComputedStyle(el).direction),
    rtlLocator.evaluate((el) => getComputedStyle(el).direction),
  ]);
  expect(ltrDirection).toBe('ltr');
  expect(rtlDirection).toBe('rtl');
}

/**
 * Flow-reversal contract: a horizontal control group's element centers
 * must be in strictly increasing X order in English and strictly
 * decreasing X order in Arabic (arbiter resolution item 3).
 */
export async function assertHorizontalOrder(
  locators: Locator[],
  direction: 'increasing' | 'decreasing',
): Promise<void> {
  const boxes = await Promise.all(locators.map((locator) => locator.boundingBox()));
  const centers = boxes.map((box, index) => {
    expect(box, `expected element ${index} in the group to have a bounding box`).not.toBeNull();
    return box!.x + box!.width / 2;
  });

  for (let i = 1; i < centers.length; i += 1) {
    if (direction === 'increasing') {
      expect(centers[i]).toBeGreaterThan(centers[i - 1]);
    } else {
      expect(centers[i]).toBeLessThan(centers[i - 1]);
    }
  }
}

export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

export async function runAxe(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

/**
 * Directional-icon flip contract (arbiter resolution item 4): every screen
 * element marked `data-directional-icon` must have its Arabic computed
 * transform differ from English by a horizontal flip. Per the resolution,
 * we must NOT invent decorative icons solely for this test — if a screen
 * has none, assert the count is zero in both locales instead.
 */
export async function assertDirectionalIcons(ltrPage: Page, rtlPage: Page): Promise<void> {
  const ltrIcons = ltrPage.locator('[data-directional-icon]');
  const rtlIcons = rtlPage.locator('[data-directional-icon]');
  const ltrCount = await ltrIcons.count();
  const rtlCount = await rtlIcons.count();

  if (ltrCount === 0) {
    expect(rtlCount).toBe(0);
    return;
  }

  expect(rtlCount).toBe(ltrCount);

  for (let i = 0; i < ltrCount; i += 1) {
    const [ltrTransform, rtlTransform] = await Promise.all([
      ltrIcons.nth(i).evaluate((el) => getComputedStyle(el).transform),
      rtlIcons.nth(i).evaluate((el) => getComputedStyle(el).transform),
    ]);
    expect(rtlTransform).not.toBe(ltrTransform);
    expect(rtlTransform).toMatch(/^matrix\(-1,\s*0,\s*0,\s*1|scaleX\(-1\)/);
  }
}
