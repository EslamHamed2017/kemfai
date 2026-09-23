import { localeFromRequest, recoveryRedirectResponse } from '@/lib/auth/recovery-redirect';

/**
 * T037 — one of the two duplicate-email recovery actions (Acceptance Scenario 1.6): redirects
 * to the deployment-configured Keycloak customer-realm login URL. The URL itself lives in
 * environment configuration (KEYCLOAK_CUSTOMERS_LOGIN_URL, infra/.env.example) — never a
 * hard-coded host, realm name, or credential.
 */
export async function GET(request: Request): Promise<Response> {
  return recoveryRedirectResponse(process.env.KEYCLOAK_CUSTOMERS_LOGIN_URL, localeFromRequest(request));
}
