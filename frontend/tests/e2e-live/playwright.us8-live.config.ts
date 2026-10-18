import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '../e2e',
  testMatch: /us8-support-access\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  outputDir: process.env.US8_PLAYWRIGHT_OUTPUT_DIR,
  use: { baseURL: process.env.US8_BASE_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
