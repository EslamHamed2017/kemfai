import { createHash } from 'node:crypto';

/**
 * T056 binding-review point 1 — an opaque draft-scope token bound to the authenticated
 * tenant + account + company, included in every `CompanySetupState` response so the
 * frontend can detect an account/company transition (e.g. a user session moving from one
 * tenant's wizard to another's) without ever being handed, or deriving authority from,
 * the raw tenant/account/company identifiers themselves. The frontend only ever compares
 * two of these for equality.
 */
export function computeCompanySetupScope(
  tenantId: string,
  accountId: string | null,
  companyId: number,
): string {
  return createHash('sha256')
    .update(`${tenantId}:${accountId ?? ''}:${companyId}`)
    .digest('base64url');
}
