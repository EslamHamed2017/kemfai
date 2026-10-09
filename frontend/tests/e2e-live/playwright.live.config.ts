import { defineConfig } from '@playwright/test';

/**
 * T056 round-5 item 6 — dedicated Playwright config for the real, OWNED-scratch
 * browser -> BFF -> API -> Odoo harness. Unlike `playwright.config.ts` (T030, network-
 * mocked, owns its own `next dev`/stub-api webServer), this config has NO `webServer`:
 * `scripts/test_t056_live_browser.sh` starts (and tears down) the real `next start` and
 * real NestJS API processes itself, against real scratch Postgres/Redis/Odoo/Keycloak
 * containers, before invoking this config — there is nothing for Playwright to mock or
 * manage here.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.live\.spec\.ts/,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.T056_BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
