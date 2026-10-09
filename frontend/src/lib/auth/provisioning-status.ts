export interface SafeRetryStatus {
  status: 'Pending' | 'Ready';
  tenantId: string | null;
}

/**
 * The documented 202 TenantStatus for a retry: an ordinary Failed retry returns
 * Pending, the narrow Ready/null Odoo-company repair returns Ready — nothing else.
 * Deliberately has no `next/server` import so tests can call the exact validation
 * the production BFF applies without needing Request/Response globals.
 */
export function parseRetryStatus(body: unknown): SafeRetryStatus | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { status, tenantId } = body as { status?: unknown; tenantId?: unknown };
  if (status !== 'Pending' && status !== 'Ready') return null;
  return { status, tenantId: typeof tenantId === 'string' ? tenantId : null };
}
