import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.T109_BASE_URL;
const evidenceDir = process.env.T109_EVIDENCE_DIR;
if (!baseURL) throw new Error('T109_BASE_URL is required');
if (!evidenceDir || !path.isAbsolute(evidenceDir)) {
  throw new Error('T109_EVIDENCE_DIR must be an absolute path');
}
if (path.resolve(evidenceDir).startsWith(`${path.resolve(process.cwd())}${path.sep}`)) {
  throw new Error('T109_EVIDENCE_DIR must be outside the pinned frontend source');
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'full-surface-odoo-exposure-sweep.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  globalTimeout: 20 * 60_000,
  outputDir: path.join(evidenceDir, 'playwright-output'),
  reporter: [['list'], [path.join(__dirname, 'tests/e2e/support/t109-evidence-reporter.ts')]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: process.env.T109_CHROMIUM_PATH
      ? { executablePath: process.env.T109_CHROMIUM_PATH }
      : undefined,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
