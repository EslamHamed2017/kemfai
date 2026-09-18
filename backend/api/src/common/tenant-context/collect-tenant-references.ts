import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AttemptedTenantReference,
  TENANT_OWNED_RESOURCES_KEY,
  TenantOwnedResourceRef,
  TenantScopedRequest,
} from './tenant-context.model';
import { TenantOwnershipRegistry } from './tenant-ownership.registry';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ID_KEYS = new Set(['tenantid', 'tenant_id']);
const TENANT_ID_HEADER = 'x-tenant-id';

/**
 * Every tenant-owned thing a request attempts to reach: explicit tenantId values carried in
 * path/query/body/header, plus resources declared via `@TenantOwnedResource` (resolved through
 * the ownership registry). Extracted out of TenantScopeGuard (T017) so RoleGuard (T018) can
 * resolve "which tenant is this request for" identically for its Support grant-scope check
 * instead of re-deriving the same reference collection per guard (FR-006).
 */
export async function collectTenantReferences(
  reflector: Reflector,
  ownershipRegistry: TenantOwnershipRegistry,
  context: ExecutionContext,
  req: TenantScopedRequest,
): Promise<AttemptedTenantReference[]> {
  return [
    ...collectExplicitTenantReferences(req),
    ...(await resolveDeclaredResourceReferences(reflector, ownershipRegistry, context, req)),
  ];
}

function collectExplicitTenantReferences(req: TenantScopedRequest): AttemptedTenantReference[] {
  const references: AttemptedTenantReference[] = [];
  const add = (
    rawValue: unknown,
    source: AttemptedTenantReference['source'],
    attemptedId: string | null,
  ) => {
    if (typeof rawValue !== 'string' || rawValue.length === 0) {
      return;
    }
    references.push({
      resourceType: 'tenant',
      attemptedId,
      source,
      owningTenantId: UUID_PATTERN.test(rawValue) ? rawValue : null,
    });
  };

  for (const [key, value] of Object.entries(req.params ?? {})) {
    if (TENANT_ID_KEYS.has(key.toLowerCase())) {
      add(value, 'path', typeof value === 'string' ? value : null);
    }
  }
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (TENANT_ID_KEYS.has(key.toLowerCase())) {
      add(value, 'query', typeof value === 'string' ? value : null);
    }
  }
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const key of ['tenantId', 'tenant_id']) {
      if (key in body) {
        const value = (body as Record<string, unknown>)[key];
        add(value, 'body', typeof value === 'string' ? value : null);
      }
    }
  }
  const header = req.headers?.[TENANT_ID_HEADER];
  if (typeof header === 'string') {
    add(header, 'header', header);
  }
  return references;
}

async function resolveDeclaredResourceReferences(
  reflector: Reflector,
  ownershipRegistry: TenantOwnershipRegistry,
  context: ExecutionContext,
  req: TenantScopedRequest,
): Promise<AttemptedTenantReference[]> {
  const refs = reflector.getAllAndMerge<TenantOwnedResourceRef[]>(TENANT_OWNED_RESOURCES_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);
  if (!refs?.length) {
    return [];
  }
  const references: AttemptedTenantReference[] = [];
  for (const ref of refs) {
    const raw =
      (req.params?.[ref.idParam] as string | undefined) ??
      (req.query?.[ref.idParam] as string | undefined);
    if (typeof raw !== 'string' || raw.length === 0) {
      continue;
    }
    references.push({
      resourceType: ref.resource,
      attemptedId: raw,
      source: 'resource',
      owningTenantId: await ownershipRegistry.resolveOwningTenantId(ref.resource, raw),
    });
  }
  return references;
}
