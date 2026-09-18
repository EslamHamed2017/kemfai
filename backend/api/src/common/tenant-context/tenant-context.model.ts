import { AuthenticatedRequest } from '../guards/bearer-auth.guard';

/**
 * Per-request resolution of who is calling and which tenant they belong to (T017, FR-001).
 * `callerTenantId` is resolved server-side from the verified JWT `sub` → Account → Tenant
 * (1:1), never from client-supplied tenant identifiers.
 */
export interface TenantContext {
  keycloakUserId: string;
  accountId: string | null;
  callerTenantId: string | null;
}

export interface TenantScopedRequest extends AuthenticatedRequest {
  tenantContext?: TenantContext;
}

export const TENANT_OWNED_RESOURCES_KEY = 'kemfai:tenantOwnedResources';

/**
 * Declarative route metadata telling TenantScopeGuard that a route parameter (or query
 * field) carries the ID of a tenant-owned resource, so the guard can ownership-check it
 * through the TenantOwnershipRegistry — this is how resources addressed by an *ordinary*
 * resource ID (not an explicit tenantId field) are still cross-tenant checked (T017
 * acceptance criterion "any Tenant B resource"; FR-001/SC-004).
 */
export interface TenantOwnedResourceRef {
  /** Registry key, e.g. 'subscription', 'payment_submission', 'support_access_grant', 'tenant'. */
  resource: string;
  /** Name of the route param or query field carrying the resource ID. */
  idParam: string;
}

/** How the denied request referenced the target tenant/resource. */
export type TenantReferenceSource = 'path' | 'query' | 'body' | 'header' | 'resource';

/**
 * One tenant-owned thing this request attempted to reach. `owningTenantId` is the
 * server-resolved owner: for explicit tenant references it is the attempted value itself
 * (when a valid UUID); for declared resource references it is looked up via the registry.
 * `null` means the referenced entity does not exist (or the id is not a UUID) — such
 * requests are not cross-tenant denials and fall through so the handler can answer 404.
 */
export interface AttemptedTenantReference {
  resourceType: string;
  attemptedId: string | null;
  source: TenantReferenceSource;
  owningTenantId: string | null;
}
