import { Reflector } from '@nestjs/core';
import { FEATURE_FLAG_KEY } from '../../common/decorators/feature-flag.decorator';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { AccountingOdooContextService } from './accounting-odoo-context.service';
import { AccountingCapabilitiesController } from './capabilities.controller';

const COMPANY_UUID = '33333333-3333-4333-8333-333333333333';

function request(): TenantScopedRequest {
  return {
    auth: { keycloakUserId: '44444444-4444-4444-8444-444444444444', roles: [] },
  } as unknown as TenantScopedRequest;
}

describe('AccountingCapabilitiesController (T053)', () => {
  const context = { resolve: jest.fn() } as unknown as AccountingOdooContextService;
  let controller: AccountingCapabilitiesController;

  beforeEach(() => {
    jest.clearAllMocks();
    (context.resolve as jest.Mock).mockResolvedValue({
      tenantId: '11111111-1111-4111-8111-111111111111',
      accountId: '22222222-2222-4222-8222-222222222222',
      companyUuid: COMPANY_UUID,
      db: 'private-db',
      uid: 7,
      password: 'private-password',
      companyId: 91,
    });
    controller = new AccountingCapabilitiesController(context);
  });

  it('authorizes the routed company before returning only policy-safe capabilities', async () => {
    const req = request();

    await expect(controller.get(req, COMPANY_UUID)).resolves.toEqual({
      foundationEnabled: true,
      draftsEnabled: true,
      postingEnabled: false,
      reversalEnabled: false,
      openingPostingEnabled: false,
      periodEnforcementEnabled: false,
      policyGate: 'OWNER_APPROVAL_REQUIRED',
    });
    expect(context.resolve).toHaveBeenCalledTimes(1);
    expect(context.resolve).toHaveBeenCalledWith(req, COMPANY_UUID);
  });

  it('fails closed when company scope cannot be authorized', async () => {
    (context.resolve as jest.Mock).mockRejectedValue(new Error('scope denied'));

    await expect(controller.get(request(), COMPANY_UUID)).rejects.toThrow('scope denied');
  });

  it('is hidden behind the accounting foundation feature flag', () => {
    const reflector = new Reflector();

    expect(reflector.get(FEATURE_FLAG_KEY, AccountingCapabilitiesController)).toBe(
      'module.accounting_foundation',
    );
  });
});
