import { ForbiddenException } from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { Account } from '../../modules/accounts/entities/account.entity';
import { Tenant, TenantStatus } from '../../modules/tenants/entities/tenant.entity';
import { TenantScopedRequest } from '../tenant-context/tenant-context.model';

/** The claim is a signed assertion to compare, never a source of tenant ownership. */
export async function requireReadyWorkspaceOwner(req: TenantScopedRequest): Promise<void> {
  if (!req.auth?.roles?.includes('WorkspaceOwner') || !req.auth.tenantId) {
    throw new ForbiddenException('Workspace owner access denied');
  }
  const account = await controlDataSource.getRepository(Account).findOneBy({
    keycloakUserId: req.auth.keycloakUserId,
  });
  const tenant =
    account && (await controlDataSource.getRepository(Tenant).findOneBy({ accountId: account.id }));
  if (
    !account?.emailVerified ||
    !tenant ||
    tenant.status !== TenantStatus.READY ||
    tenant.id !== req.auth.tenantId
  ) {
    throw new ForbiddenException('Workspace owner access denied');
  }
}
