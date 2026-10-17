import controlDataSource from '../../database/data-source';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { Tenant, TenantStatus } from '../tenants/entities/tenant.entity';
import { ModuleSelectionRecoveryWorker } from './module-selection-recovery.worker';
import { ModuleSelectionService } from './module-selection.service';

describe('ModuleSelectionRecoveryWorker (T076)', () => {
  it('recovers an Odoo-committed receipt without an HTTP retry', async () => {
    const tenant = {
      id: '07610000-0000-4000-8000-000000000001',
      status: TenantStatus.READY,
      odooDbName: 't076_recovery',
      createdAt: new Date(),
    } as Tenant;
    jest.spyOn(controlDataSource, 'getRepository').mockReturnValue({
      find: jest.fn().mockResolvedValue([tenant]),
    } as never);
    const receipt = {
      operationUuid: '07610000-0000-4000-8000-000000000002',
      tenantId: tenant.id,
      accountId: '07610000-0000-4000-8000-000000000003',
      actorKeycloakUserId: '07610000-0000-4000-8000-000000000004',
      occurredAt: '2026-10-17 08:00:00',
      featureKeys: ['module.accounting'],
      added: ['module.accounting'],
      removed: [],
    };
    const odoo = {
      authenticate: jest.fn().mockResolvedValue(7),
      executeKw: jest.fn().mockResolvedValue(receipt),
    } as unknown as OdooRpcService;
    const selections = {
      auditAndAcknowledge: jest.fn().mockResolvedValue(undefined),
    } as unknown as ModuleSelectionService;
    const worker = new ModuleSelectionRecoveryWorker(odoo, selections);

    await worker.tick();

    expect(selections.auditAndAcknowledge).toHaveBeenCalledWith(
      tenant.odooDbName,
      7,
      expect.any(String),
      receipt,
    );
  });

  it('rotates beyond the first recovery batch so tenant eleven cannot starve', async () => {
    const tenants = Array.from({ length: 11 }, (_, index) => ({
      id: `07610000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      status: TenantStatus.READY,
      odooDbName: `t076_recovery_${index + 1}`,
      createdAt: new Date(2026, 0, 1, 0, 0, index),
    })) as Tenant[];
    const find = jest
      .fn()
      .mockImplementation(({ skip = 0, take = 10 }) =>
        Promise.resolve(tenants.slice(skip, skip + take)),
      );
    jest.spyOn(controlDataSource, 'getRepository').mockReturnValue({ find } as never);
    const receipt = {
      operationUuid: '07610000-0000-4000-8000-000000000099',
      tenantId: tenants[10].id,
      accountId: '07610000-0000-4000-8000-000000000003',
      actorKeycloakUserId: '07610000-0000-4000-8000-000000000004',
      occurredAt: '2026-10-17T08:00:00.000Z',
      featureKeys: ['module.accounting'],
      added: ['module.accounting'],
      removed: [],
    };
    const odoo = {
      authenticate: jest.fn().mockResolvedValue(7),
      executeKw: jest
        .fn()
        .mockImplementation((database: string) =>
          Promise.resolve(database === tenants[10].odooDbName ? receipt : false),
        ),
    } as unknown as OdooRpcService;
    const selections = {
      auditAndAcknowledge: jest.fn().mockResolvedValue(undefined),
    } as unknown as ModuleSelectionService;
    const worker = new ModuleSelectionRecoveryWorker(odoo, selections);

    await worker.tick();
    expect(selections.auditAndAcknowledge).not.toHaveBeenCalled();
    await worker.tick();

    expect(find).toHaveBeenNthCalledWith(1, expect.objectContaining({ skip: 0, take: 10 }));
    expect(find).toHaveBeenNthCalledWith(2, expect.objectContaining({ skip: 10, take: 10 }));
    expect(selections.auditAndAcknowledge).toHaveBeenCalledWith(
      tenants[10].odooDbName,
      7,
      expect.any(String),
      receipt,
    );
  });
});
