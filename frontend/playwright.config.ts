import { defineConfig, devices } from '@playwright/test';

const PORT = 3411;
const baseURL = `http://localhost:${PORT}`;

/**
 * T030 — dedicated Playwright suite for EN/AR-RTL geometry, flow-order, and
 * accessibility coverage (FR-013/FR-014, SC-005). Runs against a production Next build
 * (not jest, which only scans `tests/unit/**`) with backend calls mocked at
 * the network layer via `page.route`, so this suite has no dependency on a
 * running Odoo/NestJS stack.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // This file drives Docker/SQL through scripts/test_t112_owned_fixture.sh and
  // has its own exact-resource Playwright config. The generic suite covers the
  // same feature-flag UI with network stubs; do not report the owned fixture as
  // skipped or let it accidentally target shared infrastructure.
  testIgnore: [
    '**/feature-flag-ui-gating.spec.ts',
    // Canonical-path wrapper for scripts/test-us8-owned-live.sh. Its imported
    // suite executes Docker and calls a genuine API, so it is not a stub e2e.
    '**/us8-support-access.spec.ts',
  ],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
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
      command:
        'exec env REDIS_URL="${KEMFAI_E2E_REDIS_URL:-$REDIS_URL}" node tests/e2e/support/stub-api.js',
      url: 'http://127.0.0.1:4100/accounts/me/locale',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `if [ -f .env.e2e ]; then set -a; . ./.env.e2e; set +a; fi; export REDIS_URL="\${KEMFAI_E2E_REDIS_URL:-$REDIS_URL}" SUPPORT_EMAIL=support@example.test INTERNAL_KEYCLOAK_ISSUER=http://127.0.0.1:4100/internal-realm INTERNAL_KEYCLOAK_BACKCHANNEL_URL=http://127.0.0.1:4100/internal-realm INTERNAL_KEYCLOAK_JWKS_URI=http://127.0.0.1:4100/internal-realm/certs INTERNAL_KEYCLOAK_CLIENT_ID=kemfai-internal-ui INTERNAL_KEYCLOAK_REDIRECT_URI=http://localhost:${PORT}/internal-auth/callback; node_modules/.bin/next build && exec node_modules/.bin/next start --port ${PORT}`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
});
