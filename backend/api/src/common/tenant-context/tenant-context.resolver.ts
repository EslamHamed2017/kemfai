import { Injectable } from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { Account } from '../../modules/accounts/entities/account.entity';
import { Tenant } from '../../modules/tenants/entities/tenant.entity';
import { TenantContext, TenantScopedRequest } from './tenant-context.model';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Request-scoped TenantContext resolution (T017): resolves the caller's Account and
 * (1:1) Tenant from the verified JWT `sub` only, memoized on the request object so every
 * later consumer in the same request shares one resolution. The context is derived
 * exclusively from `req.auth.keycloakUserId` (set by BearerAuthGuard) — a client cannot
 * influence it through params, query, body, or headers.
 */
@Injectable()
export class TenantContextResolver {
  async resolveForRequest(req: TenantScopedRequest): Promise<TenantContext> {
    if (!req.tenantContext) {
      req.tenantContext = await this.load(req.auth.keycloakUserId);
    }
    return req.tenantContext;
  }

  private async load(keycloakUserId: string): Promise<TenantContext> {
    // Same guard as EntitlementsService: a malformed sub must never reach the uuid-typed
    // keycloak_user_id column as a raw query parameter.
    if (!UUID_PATTERN.test(keycloakUserId)) {
      return { keycloakUserId, accountId: null, callerTenantId: null };
    }
    const accountRepo = controlDataSource.getRepository(Account);
    const account = await accountRepo.findOne({ where: { keycloakUserId } });
    if (!account) {
      return { keycloakUserId, accountId: null, callerTenantId: null };
    }
    const tenantRepo = controlDataSource.getRepository(Tenant);
    const tenant = await tenantRepo.findOne({ where: { accountId: account.id } });
    return { keycloakUserId, accountId: account.id, callerTenantId: tenant?.id ?? null };
  }
}
