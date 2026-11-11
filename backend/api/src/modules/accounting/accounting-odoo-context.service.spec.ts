import {
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { TenantContextResolver } from '../../common/tenant-context/tenant-context.resolver';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { Tenant, TenantStatus } from '../tenants/entities/tenant.entity';
import { AccountingOdooContextService } from './accounting-odoo-context.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_UUID = '33333333-3333-4333-8333-333333333333';

function request(): TenantScopedRequest {
  return {
    auth: { keycloakUserId: '44444444-4444-4444-8444-444444444444', roles: [] },
    headers: { 'x-tenant-id': 'attacker-controlled' },
    body: { tenantId: 'attacker-controlled' },
  } as unknown as TenantScopedRequest;
}

describe('AccountingOdooContextService (T047)', () => {
  const resolver = {
    resolveForRequest: jest.fn(),
  } as unknown as TenantContextResolver;
  const odoo = {
    authenticate: jest.fn(),
    executeKw: jest.fn(),
  } as unknown as OdooRpcService;
  const findOneBy = jest.fn();
  let service: AccountingOdooContextService;

  beforeEach(() => {
    process.env.KEMFAI_ODOO_MASTER_PASSWORD = 'test-master';
    process.env.KEMFAI_TENANT_ADMIN_LOGIN = 'test-admin';
    process.env.KEMFAI_TENANT_ADMIN_PASSWORD = 'test-password';
    jest.clearAllMocks();
    jest.spyOn(controlDataSource, 'getRepository').mockReturnValue({ findOneBy } as never);
    service = new AccountingOdooContextService(resolver, odoo);
    (resolver.resolveForRequest as jest.Mock).mockResolvedValue({
      keycloakUserId: '44444444-4444-4444-8444-444444444444',
      accountId: ACCOUNT_ID,
      callerTenantId: TENANT_ID,
    });
    findOneBy.mockResolvedValue({
      id: TENANT_ID,
      accountId: ACCOUNT_ID,
      status: TenantStatus.READY,
      odooDbName: 'tenant_a_private_db',
    } as Tenant);
    (odoo.authenticate as jest.Mock).mockResolvedValue(7);
    (odoo.executeKw as jest.Mock).mockResolvedValue([{ id: 91, kemfai_public_id: COMPANY_UUID }]);
  });

  afterEach(() => jest.restoreAllMocks());

  it('derives tenant routing only from JWT context and resolves the public company UUID in that tenant DB', async () => {
    const context = await service.resolve(request(), COMPANY_UUID);

    expect(findOneBy).toHaveBeenCalledWith({ id: TENANT_ID, accountId: ACCOUNT_ID });
    expect(odoo.authenticate).toHaveBeenCalledWith(
      'tenant_a_private_db',
      expect.any(String),
      expect.any(String),
    );
    expect(odoo.executeKw).toHaveBeenCalledWith(
      'tenant_a_private_db',
      7,
      expect.any(String),
      'res.company',
      'search_read',
      [[['kemfai_public_id', '=', COMPANY_UUID]]],
      { fields: ['id', 'kemfai_public_id'], limit: 2 },
    );
    expect(context).toEqual({
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      companyUuid: COMPANY_UUID,
      db: 'tenant_a_private_db',
      uid: 7,
      password: expect.any(String),
      companyId: 91,
    });
  });

  it.each([
    ['not-a-uuid', []],
    ['55555555-5555-4555-8555-555555555555', []],
  ])('fails opaquely for malformed or foreign company %s', async (companyUuid, rows) => {
    (odoo.executeKw as jest.Mock).mockResolvedValue(rows);
    let error: unknown;
    try {
      await service.resolve(request(), companyUuid);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toBe('Accounting company was not found');
    expect((error as Error).message).not.toMatch(/tenant|database|odoo|91/i);
    if (companyUuid === 'not-a-uuid') {
      expect(odoo.authenticate).not.toHaveBeenCalled();
      expect(odoo.executeKw).not.toHaveBeenCalled();
    }
  });

  it('does not route when the authenticated identity has no tenant/account membership', async () => {
    (resolver.resolveForRequest as jest.Mock).mockResolvedValue({
      keycloakUserId: '44444444-4444-4444-8444-444444444444',
      accountId: null,
      callerTenantId: null,
    });
    await expect(service.resolve(request(), COMPANY_UUID)).rejects.toThrow(
      'Accounting company was not found',
    );
    expect(findOneBy).not.toHaveBeenCalled();
    expect(odoo.authenticate).not.toHaveBeenCalled();
  });

  it('redacts raw Odoo routing failures at the public service boundary', async () => {
    (odoo.executeKw as jest.Mock).mockRejectedValue(
      new Error('res.company failed in tenant_a_private_db for integer 91'),
    );
    let error: unknown;
    try {
      await service.resolve(request(), COMPANY_UUID);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toBe('Accounting workspace is temporarily unavailable');
    expect((error as Error).message).not.toMatch(/res\.company|tenant_a_private_db|91/);
  });

  it('fails closed when registry routing is not ready or company mapping is ambiguous', async () => {
    findOneBy.mockResolvedValueOnce({
      id: TENANT_ID,
      accountId: ACCOUNT_ID,
      status: TenantStatus.READY,
      odooDbName: null,
    } as Tenant);
    await expect(service.resolve(request(), COMPANY_UUID)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );

    findOneBy.mockResolvedValue({
      id: TENANT_ID,
      accountId: ACCOUNT_ID,
      status: TenantStatus.READY,
      odooDbName: 'tenant_a_private_db',
    } as Tenant);
    (odoo.executeKw as jest.Mock).mockResolvedValue([
      { id: 91, kemfai_public_id: COMPANY_UUID },
      { id: 92, kemfai_public_id: COMPANY_UUID },
    ]);
    await expect(service.resolve(request(), COMPANY_UUID)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
