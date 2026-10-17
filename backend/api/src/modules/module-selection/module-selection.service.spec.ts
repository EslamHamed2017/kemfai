import { ForbiddenException } from '@nestjs/common';
import { TenantContextResolver } from '../../common/tenant-context/tenant-context.resolver';
import controlDataSource from '../../database/data-source';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { AuditService } from '../audit/audit.service';
import { Account } from '../accounts/entities/account.entity';
import { Feature } from '../entitlements/entities/feature.entity';
import { Plan } from '../entitlements/entities/plan.entity';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { Tenant } from '../tenants/entities/tenant.entity';
import { ModuleSelectionService } from './module-selection.service';

const ACCOUNT_ID = '07600000-0000-4000-8000-000000000001';
const TENANT_ID = '07600000-0000-4000-8000-000000000002';
const SUBJECT_ID = '07600000-0000-4000-8000-000000000003';
const PLAN_ID = '07600000-0000-4000-8000-000000000004';

describe('ModuleSelectionService (T076)', () => {
  const tenantContext = {
    resolveForRequest: jest.fn().mockResolvedValue({
      accountId: ACCOUNT_ID,
      callerTenantId: TENANT_ID,
      keycloakUserId: SUBJECT_ID,
    }),
  } as unknown as TenantContextResolver;
  const entitlements = {
    getEntitlementSetForAccount: jest.fn(),
    getEntitlementSet: jest.fn(),
  } as unknown as EntitlementsService;
  const odoo = {
    authenticate: jest.fn(),
    executeKw: jest.fn(),
  } as unknown as OdooRpcService;
  const audit = {
    recordModulesSelectionChanged: jest.fn(),
  } as unknown as AuditService;
  const req = {
    auth: { keycloakUserId: SUBJECT_ID, roles: ['WorkspaceOwner'], tenantId: TENANT_ID },
  } as TenantScopedRequest;

  let service: ModuleSelectionService;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: unknown) => {
      if (target === Tenant) {
        return {
          findOneBy: jest.fn().mockResolvedValue({
            id: TENANT_ID,
            accountId: ACCOUNT_ID,
            odooDbName: 't076_tenant',
          }),
        } as never;
      }
      if (target === Account) {
        return {
          findOneBy: jest.fn().mockResolvedValue({ id: ACCOUNT_ID, keycloakUserId: SUBJECT_ID }),
        } as never;
      }
      if (target === Plan) {
        return {
          find: jest.fn().mockResolvedValue([
            {
              id: PLAN_ID,
              name: 'Starter',
              nameEn: 'Starter',
              nameAr: 'الأساسية',
              createdAt: new Date(0),
            },
            {
              id: '07600000-0000-4000-8000-000000000005',
              name: 'Growth',
              nameEn: 'Growth',
              nameAr: 'النمو',
              createdAt: new Date(1),
            },
          ]),
        } as never;
      }
      if (target === Feature) {
        return {
          find: jest.fn().mockResolvedValue([
            { key: 'module.accounting', displayNameEn: 'Accounting', displayNameAr: 'المحاسبة' },
            { key: 'module.inventory', displayNameEn: 'Inventory', displayNameAr: 'المخزون' },
          ]),
        } as never;
      }
      throw new Error(`Unexpected T076 repository: ${String(target)}`);
    });
    service = new ModuleSelectionService(tenantContext, entitlements, odoo, audit);
  });

  it('rejects a non-entitled key before Odoo authentication or mutation', async () => {
    jest
      .mocked(entitlements.getEntitlementSetForAccount)
      .mockResolvedValue(entitlementSet(PLAN_ID, ['module.accounting']));

    await expect(
      service.replace(req, ['module.accounting', 'module.inventory']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(odoo.authenticate).not.toHaveBeenCalled();
    expect(odoo.executeKw).not.toHaveBeenCalled();
    expect(audit.recordModulesSelectionChanged).not.toHaveBeenCalled();
  });

  it('rejects an entitled LIMIT feature before Odoo authentication or mutation', async () => {
    jest
      .mocked(entitlements.getEntitlementSetForAccount)
      .mockResolvedValue(entitlementSet(PLAN_ID, ['report.export']));

    await expect(service.replace(req, ['report.export'])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(odoo.authenticate).not.toHaveBeenCalled();
    expect(odoo.executeKw).not.toHaveBeenCalled();
    expect(audit.recordModulesSelectionChanged).not.toHaveBeenCalled();
  });

  it('atomically replaces the entitled set and awaits the change audit', async () => {
    jest
      .mocked(entitlements.getEntitlementSetForAccount)
      .mockResolvedValue(entitlementSet(PLAN_ID, ['module.accounting', 'module.inventory']));
    jest.mocked(odoo.authenticate).mockResolvedValue(9);
    jest.mocked(odoo.executeKw).mockImplementation(async (...args: unknown[]) => {
      const method = args[4];
      if (method === 'kemfai_ack_selection_event') return true;
      const rpcArgs = args[5] as unknown[];
      return {
        operationUuid: rpcArgs[1],
        tenantId: TENANT_ID,
        accountId: ACCOUNT_ID,
        actorKeycloakUserId: SUBJECT_ID,
        occurredAt: '2026-10-17 08:00:00',
        featureKeys: ['module.inventory'],
        added: ['module.inventory'],
        removed: ['module.accounting'],
      };
    });
    jest.mocked(audit.recordModulesSelectionChanged).mockResolvedValue(undefined);

    await expect(service.replace(req, ['module.inventory'])).resolves.toEqual({
      featureKeys: ['module.inventory'],
    });
    expect(audit.recordModulesSelectionChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        added: ['module.inventory'],
        removed: ['module.accounting'],
        operationUuid: expect.any(String),
      }),
    );
  });

  it('preserves the original delta when audit fails after Odoo commits and the request retries', async () => {
    jest
      .mocked(entitlements.getEntitlementSetForAccount)
      .mockResolvedValue(entitlementSet(PLAN_ID, ['module.accounting']));
    jest.mocked(odoo.authenticate).mockResolvedValue(9);
    let replaceCalls = 0;
    jest.mocked(odoo.executeKw).mockImplementation(async (...args: unknown[]) => {
      if (args[4] === 'kemfai_ack_selection_event') return true;
      replaceCalls += 1;
      const rpcArgs = args[5] as unknown[];
      if (replaceCalls <= 2)
        return {
          operationUuid: '07600000-0000-4000-8000-000000000007',
          tenantId: TENANT_ID,
          accountId: ACCOUNT_ID,
          actorKeycloakUserId: SUBJECT_ID,
          occurredAt: '2026-10-17 08:00:00',
          featureKeys: ['module.accounting'],
          added: ['module.accounting'],
          removed: [],
        };
      return {
        operationUuid: rpcArgs[1],
        tenantId: TENANT_ID,
        accountId: ACCOUNT_ID,
        actorKeycloakUserId: SUBJECT_ID,
        occurredAt: '2026-10-17 08:00:00',
        featureKeys: ['module.accounting'],
        added: [],
        removed: [],
      };
    });
    jest
      .mocked(audit.recordModulesSelectionChanged)
      .mockRejectedValueOnce(new Error('synthetic audit outage'))
      .mockResolvedValueOnce(undefined);

    await expect(service.replace(req, ['module.accounting'])).rejects.toThrow(
      'synthetic audit outage',
    );
    await expect(service.replace(req, ['module.accounting'])).resolves.toEqual({
      featureKeys: ['module.accounting'],
    });

    expect(audit.recordModulesSelectionChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        operationUuid: '07600000-0000-4000-8000-000000000007',
        added: ['module.accounting'],
        removed: [],
      }),
    );
  });

  it('derives inclusion and stable upgrade labels only through EntitlementsService', async () => {
    const growthId = '07600000-0000-4000-8000-000000000005';
    jest
      .mocked(entitlements.getEntitlementSetForAccount)
      .mockResolvedValue(entitlementSet(PLAN_ID, ['module.accounting']));
    jest
      .mocked(entitlements.getEntitlementSet)
      .mockImplementation(async (planId) =>
        planId === PLAN_ID
          ? entitlementSet(PLAN_ID, ['module.accounting'])
          : entitlementSet(growthId, ['module.accounting', 'module.inventory']),
      );
    jest.mocked(odoo.authenticate).mockResolvedValue(9);
    jest.mocked(odoo.executeKw).mockResolvedValue(['module.accounting']);

    await expect(service.list(req)).resolves.toEqual([
      {
        key: 'module.accounting',
        name: 'Accounting',
        nameAr: 'المحاسبة',
        includedInCurrentPlan: true,
        selected: true,
        requiredPlanTier: null,
        requiredPlanTierAr: null,
      },
      {
        key: 'module.inventory',
        name: 'Inventory',
        nameAr: 'المخزون',
        includedInCurrentPlan: false,
        selected: false,
        requiredPlanTier: 'Growth',
        requiredPlanTierAr: 'النمو',
      },
    ]);
    expect(odoo.executeKw).toHaveBeenCalledWith(
      't076_tenant',
      9,
      expect.any(String),
      'kemfai.module.selection',
      'kemfai_get_selection',
      [],
    );
  });

  it('does not expose a persisted selection after its current entitlement is revoked', async () => {
    const growthId = '07600000-0000-4000-8000-000000000005';
    jest
      .mocked(entitlements.getEntitlementSetForAccount)
      .mockResolvedValue(entitlementSet(PLAN_ID, ['module.accounting']));
    jest
      .mocked(entitlements.getEntitlementSet)
      .mockImplementation(async (planId) =>
        planId === PLAN_ID
          ? entitlementSet(PLAN_ID, ['module.accounting'])
          : entitlementSet(growthId, ['module.accounting', 'module.inventory']),
      );
    jest.mocked(odoo.authenticate).mockResolvedValue(9);
    jest.mocked(odoo.executeKw).mockResolvedValue(['module.inventory']);

    await expect(service.list(req)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'module.inventory',
          includedInCurrentPlan: false,
          selected: false,
        }),
      ]),
    );
  });
});

function entitlementSet(planId: string, enabledKeys: string[]) {
  return {
    planId,
    features: enabledKeys.map((key) => ({ key, enabled: true, limitValue: null })),
    trialWindowDays: 14,
    autoRestrictUnpaid: true,
    featureFlags: [],
  };
}
