import { isDeepStrictEqual } from 'util';

export interface AuditLinkQuery {
  query(sql: string, parameters?: unknown[]): Promise<any[]>;
}

export interface AuditLink {
  action: string;
  subjectType: string;
  subjectId: string;
  tenantId: string | null;
  payload: Record<string, unknown>;
}

const SUBJECT_TYPES = new Set([
  'account',
  'tenant',
  'company',
  'module_selection',
  'payment_submission',
  'subscription',
  'support_access_grant',
]);

export async function assertAuditSourceLinked(db: AuditLinkQuery, event: AuditLink): Promise<void> {
  if (!SUBJECT_TYPES.has(event.subjectType)) {
    throw new Error(`unrecognized audit subject type: ${event.subjectType}`);
  }

  if (event.action === 'tenant_access.denied_cross_tenant') {
    const targetTenantId = stringPayload(event.payload, 'target_tenant_id');
    if (!targetTenantId) throw new Error('cross-tenant denial has no target_tenant_id');
    await requireOwnedSource(db, event, targetTenantId);
    if (!event.tenantId || event.tenantId === targetTenantId) {
      throw new Error(
        'cross-tenant denial does not identify distinct requesting and target tenants',
      );
    }
    await requireTableRow(db, 'tenant', event.tenantId, event.tenantId);
    return;
  }

  await requireOwnedSource(db, event, event.tenantId);

  if (event.action === 'billing.payment_submission.decided') {
    const audited = event.payload.status_history;
    const rows = await db.query('SELECT status_history FROM payment_submission WHERE id = $1', [
      event.subjectId,
    ]);
    const source = rows[0]?.status_history;
    if (!Array.isArray(audited) || audited.length === 0 || !Array.isArray(source)) {
      throw new Error('payment decision requires non-empty inspectable status_history');
    }
    for (const entry of audited) {
      if (!source.some((sourceEntry: unknown) => isDeepStrictEqual(sourceEntry, entry))) {
        throw new Error('payment decision history entry does not structurally match source');
      }
    }
  }
}

async function requireOwnedSource(
  db: AuditLinkQuery,
  event: AuditLink,
  ownerTenantId: string | null,
): Promise<void> {
  switch (event.subjectType) {
    case 'account': {
      const rows = await db.query(
        `SELECT a.id, t.id AS tenant_id FROM account a
         LEFT JOIN tenant t ON t.account_id = a.id WHERE a.id = $1`,
        [event.subjectId],
      );
      if (!rows.length || (ownerTenantId !== null && rows[0].tenant_id !== ownerTenantId)) {
        missing(event.subjectType, event.subjectId);
      }
      return;
    }
    case 'tenant':
      return requireTableRow(db, 'tenant', event.subjectId, ownerTenantId);
    case 'company': {
      if (event.subjectId !== ownerTenantId) missing(event.subjectType, event.subjectId);
      return requireTableRow(db, 'tenant', event.subjectId, ownerTenantId);
    }
    case 'module_selection':
      if (event.subjectId !== ownerTenantId) missing(event.subjectType, event.subjectId);
      return requireTableRow(db, 'tenant', event.subjectId, ownerTenantId);
    case 'payment_submission':
    case 'subscription':
    case 'support_access_grant':
      return requireTableRow(db, event.subjectType, event.subjectId, ownerTenantId);
  }
}

async function requireTableRow(
  db: AuditLinkQuery,
  table: string,
  id: string,
  tenantId: string | null,
): Promise<void> {
  const tenantColumn = table === 'tenant' ? 'id' : 'tenant_id';
  const rows = await db.query(
    `SELECT id FROM ${table} WHERE id = $1 AND ${tenantColumn} IS NOT DISTINCT FROM $2`,
    [id, tenantId],
  );
  if (!rows.length) missing(table, id);
}

function stringPayload(payload: Record<string, unknown>, key: string): string | null {
  return typeof payload[key] === 'string' ? (payload[key] as string) : null;
}

function missing(type: string, id: string): never {
  throw new Error(`audit subject is missing or belongs to the wrong tenant: ${type}/${id}`);
}
