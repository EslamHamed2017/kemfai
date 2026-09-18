import { Injectable } from '@nestjs/common';
import controlDataSource from '../../database/data-source';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OwnershipResolver = (resourceId: string) => Promise<string | null>;

/**
 * Registry mapping a tenant-owned resource type to a resolver that returns the tenant
 * owning a given resource ID (T017). This is what makes "any Tenant B resource" deniable
 * even when the request addresses the resource by an ordinary ID (e.g.
 * GET /billing/payment-submissions/<foreign-id>) with no explicit tenantId anywhere in
 * the request (FR-001, SC-004).
 *
 * Default resolvers cover every tenant-owned control-plane table that exists today
 * (Tenant T008, Subscription T011, PaymentSubmission T012, SupportAccessGrant T013).
 * Later slices register additional resolvers via `register()` instead of growing
 * per-endpoint checks inside the guard.
 */
@Injectable()
export class TenantOwnershipRegistry {
  private readonly resolvers = new Map<string, OwnershipResolver>();

  constructor() {
    // A Tenant row is owned by itself.
    this.register('tenant', async (resourceId) => {
      const tenant = await controlDataSource.query('SELECT id FROM tenant WHERE id = $1', [
        resourceId,
      ]);
      return (tenant[0]?.id as string | undefined) ?? null;
    });
    this.register('subscription', selectOwningTenantId('subscription'));
    this.register('payment_submission', selectOwningTenantId('payment_submission'));
    this.register('support_access_grant', selectOwningTenantId('support_access_grant'));
  }

  /** Registers (or replaces) the resolver for a resource type. */
  register(resourceType: string, resolver: OwnershipResolver): void {
    this.resolvers.set(resourceType, resolver);
  }

  has(resourceType: string): boolean {
    return this.resolvers.has(resourceType);
  }

  /**
   * Returns the tenant owning `resourceId`, or null when the id is not a UUID, the type
   * is unknown, or no such row exists — null always means "cannot attribute", never
   * "granted": callers treat it as "let the handler answer 404".
   */
  async resolveOwningTenantId(resourceType: string, resourceId: string): Promise<string | null> {
    if (!UUID_PATTERN.test(resourceId) || !this.resolvers.has(resourceType)) {
      return null;
    }
    return this.resolvers.get(resourceType)!(resourceId);
  }
}

function selectOwningTenantId(tableName: string): OwnershipResolver {
  return async (resourceId) => {
    const rows = await controlDataSource.query(`SELECT tenant_id FROM ${tableName} WHERE id = $1`, [
      resourceId,
    ]);
    return (rows[0]?.tenant_id as string | undefined) ?? null;
  };
}
