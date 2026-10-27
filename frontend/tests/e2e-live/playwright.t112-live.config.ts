import { defineConfig } from '@playwright/test';

const jsonOutput = process.env.T112_PLAYWRIGHT_JSON;
if (!jsonOutput) throw new Error('T112_PLAYWRIGHT_JSON is required');

export default defineConfig({
  testDir: '../e2e',
  testMatch: /feature-flag-ui-gating\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list'], ['json', { outputFile: jsonOutput }]],
  outputDir: process.env.T112_PLAYWRIGHT_OUTPUT_DIR,
  use: {
    baseURL: process.env.T112_BASE_URL,
    // A trace captures cookies and request headers; the owned fixture deliberately keeps
    // credential material out of durable T112 evidence.
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
