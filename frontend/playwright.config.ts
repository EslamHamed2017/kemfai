import { defineConfig, devices } from '@playwright/test';

const PORT = 3411;
const baseURL = `http://localhost:${PORT}`;

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
  webServer: [
    {
      command: 'exec env REDIS_URL="${KEMFAI_E2E_REDIS_URL:-$REDIS_URL}" node tests/e2e/support/stub-api.js',
      url: 'http://127.0.0.1:4100/accounts/me/locale',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `if [ -f .env.e2e ]; then set -a; . ./.env.e2e; set +a; fi; exec env REDIS_URL="\${KEMFAI_E2E_REDIS_URL:-$REDIS_URL}" SUPPORT_EMAIL=support@example.test INTERNAL_KEYCLOAK_ISSUER=http://127.0.0.1:4100/internal-realm INTERNAL_KEYCLOAK_BACKCHANNEL_URL=http://127.0.0.1:4100/internal-realm INTERNAL_KEYCLOAK_JWKS_URI=http://127.0.0.1:4100/internal-realm/certs INTERNAL_KEYCLOAK_CLIENT_ID=kemfai-internal-ui INTERNAL_KEYCLOAK_REDIRECT_URI=http://localhost:${PORT}/internal-auth/callback node_modules/.bin/next dev --port ${PORT}`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  });
