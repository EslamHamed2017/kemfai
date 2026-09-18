import { SetMetadata } from '@nestjs/common';
import { TENANT_OWNED_RESOURCES_KEY, TenantOwnedResourceRef } from './tenant-context.model';

/**
 * Declares that a route addresses tenant-owned resources by ordinary resource ID, so
 * TenantScopeGuard resolves the owning tenant via the TenantOwnershipRegistry and denies
 * cross-tenant access even though no explicit `tenantId` appears anywhere in the request
 * (T017 acceptance criterion; FR-001/SC-004). Apply once per handler with a single ref or
 * an array when several params carry resource IDs.
 */
export const TenantOwnedResource = (
  refs: TenantOwnedResourceRef | TenantOwnedResourceRef[],
): MethodDecorator & ClassDecorator =>
  SetMetadata(TENANT_OWNED_RESOURCES_KEY, Array.isArray(refs) ? refs : [refs]);
