import { localeFromRequest, recoveryRedirectResponse } from '@/lib/auth/recovery-redirect';

/**
 * T037 — the other duplicate-email recovery action (Acceptance Scenario 1.6): redirects to
 * the deployment-configured Keycloak customer-realm password-recovery URL. The URL itself
 * lives in environment configuration (KEYCLOAK_CUSTOMERS_RESET_PASSWORD_URL,
 * infra/.env.example) — never a hard-coded host, realm name, or credential.
 */
export async function GET(request: Request): Promise<Response> {
  return recoveryRedirectResponse(
    process.env.KEYCLOAK_CUSTOMERS_RESET_PASSWORD_URL,
    localeFromRequest(request),
  );
}
