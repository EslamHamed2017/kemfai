import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { TenantStatus } from './entities/tenant.entity';
import { AuthenticatedRequest } from '../../common/guards/bearer-auth.guard';

describe('TenantsController', () => {
  const result = { tenantId: null, status: TenantStatus.PENDING, failureReason: null };
  const status = jest.fn().mockResolvedValue(result);
  const retry = jest.fn().mockResolvedValue(result);
  const controller = new TenantsController({ status, retry } as unknown as TenantsService);
  const request = {
    auth: { keycloakUserId: 'signed-sub', roles: [] },
    body: { accountId: 'attacker' },
    query: { tenantId: 'attacker' },
  } as unknown as AuthenticatedRequest;

  beforeEach(() => jest.clearAllMocks());

  it('gets status only for the bearer subject', async () => {
    expect(await controller.status(request)).toEqual(result);
    expect(status).toHaveBeenCalledWith('signed-sub');
  });

  it('retries only for the bearer subject, never client-supplied identity', async () => {
    expect(await controller.retry(request)).toEqual(result);
    expect(retry).toHaveBeenCalledWith('signed-sub');
  });
});
