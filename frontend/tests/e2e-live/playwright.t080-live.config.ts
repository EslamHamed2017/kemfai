import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /t080-checklist\.live\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  outputDir: process.env.T080_PLAYWRIGHT_OUTPUT_DIR,
  use: { baseURL: process.env.T080_BASE_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
