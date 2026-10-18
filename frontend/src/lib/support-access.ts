export interface SupportAccessUsageView {
  id: string;
  usedBy: string;
  usedAt: string;
  actionSummary: 'workspace.summary.read';
  wasDenied: boolean;
  denialReason: 'expired' | 'revoked' | 'wrong_tenant' | 'action_not_permitted' | null;
}
export interface SupportAccessGrantView {
  id: string;
  granteeRole: 'Support';
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  expiredAt: string | null;
  status: 'active' | 'expired' | 'revoked';
  permittedActions: ['workspace.summary.read'];
  usage: SupportAccessUsageView[];
}
export function isSupportAccessGrant(value: unknown): value is SupportAccessGrantView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    row.granteeRole === 'Support' &&
    typeof row.grantedBy === 'string' &&
    typeof row.grantedAt === 'string' &&
    typeof row.expiresAt === 'string' &&
    ['active', 'expired', 'revoked'].includes(String(row.status)) &&
    Array.isArray(row.usage) &&
    Array.isArray(row.permittedActions)
  );
}
