import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /accounting-foundation\.live\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: process.env.KEMFAI_AF_PLAYWRIGHT_OUTPUT_DIR,
  use: {
    baseURL: process.env.KEMFAI_AF_FRONTEND_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
