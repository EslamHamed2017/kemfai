import { defineConfig, devices } from '@playwright/test';

const PORT = 3411;
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * T030 — dedicated Playwright suite for EN/AR-RTL geometry, flow-order, and
 * accessibility coverage (FR-013/FR-014, SC-005). Runs against `next dev`
 * (not jest, which only scans `tests/unit/**`) with backend calls mocked at
 * the network layer via `page.route`, so this suite has no dependency on a
 * running Odoo/NestJS stack.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `node_modules/.bin/next dev --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
