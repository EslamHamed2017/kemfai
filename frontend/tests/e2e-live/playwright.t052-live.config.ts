import { defineConfig } from '@playwright/test';

/**
 * T052 — real, disposable browser -> Next.js BFF -> NestJS API -> Odoo/Keycloak
 * acceptance config. The shell harness owns every service and resource, so Playwright
 * must not start, reuse, or mock a web server here.
 *
 * T052_TEST_MATCH is used only by the harness for its disposable negative-control copy.
 * It is a basename (not an arbitrary path), keeping discovery inside this directory.
 */
const testMatch = process.env.T052_TEST_MATCH ?? 't052-full-wizard.live.spec.ts';
const testDir = process.env.T052_TEST_DIR ?? '.';

if (!/^[A-Za-z0-9._-]+\.live\.spec\.ts$/.test(testMatch)) {
  throw new Error('T052_TEST_MATCH must be a safe .live.spec.ts basename');
}

export default defineConfig({
  testDir,
  testMatch,
  outputDir: process.env.T052_PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/t052-live',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.T052_BASE_URL,
    // Live traces can contain authenticated DOM/session history. T052 retains only
    // redacted text evidence outside the repo, never a private browser-history bundle.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    viewport: { width: 1280, height: 720 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
