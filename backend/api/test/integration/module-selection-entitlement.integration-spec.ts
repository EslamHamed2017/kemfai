import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { FeatureFlagGuard } from '../../src/common/guards/feature-flag.guard';
import { RoleGuard } from '../../src/common/guards/role.guard';
import { TrialWindowGuard } from '../../src/common/guards/trial-window.guard';
import { TenantContextModule } from '../../src/common/tenant-context/tenant-context.module';
import controlDataSource from '../../src/database/data-source';
import { OdooRpcService } from '../../src/integrations/odoo-rpc/odoo-rpc.service';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { AuditService } from '../../src/modules/audit/audit.service';
import {
  Subscription,
  SubscriptionStatus,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import { EntitlementsService } from '../../src/modules/entitlements/entitlements.service';
import { EntitlementsModule } from '../../src/modules/entitlements/entitlements.module';
import { Feature, FeatureKind } from '../../src/modules/entitlements/entities/feature.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { ModuleSelectionModule } from '../../src/modules/module-selection/module-selection.module';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { OpenApiContractValidator } from '../support/openapi-contract-validator';

const SUBJECT_ID = '07300000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '07300000-0000-4000-8000-000000000002';
const TENANT_ID = '07300000-0000-4000-8000-000000000003';
const PLAN_ID = '07300000-0000-4000-8000-000000000004';

/**
 * T073 entitlement denial through the actual Nest controller, RoleGuard,
 * FeatureFlagGuard and TrialWindowGuard. Authentication transport is an explicit test seam:
 * middleware supplies the already-verified request auth shape, while the existing dedicated
 * BearerAuthGuard suites own JWT/JWKS verification. PostgreSQL and Odoo are deterministic
 * synthetic repositories/RPC fakes here; this suite makes no live-resource claim.
 */
describe('PUT /modules/selection entitlement enforcement (T073)', () => {
  let app: INestApplication;
  const odoo = {
    authenticate: jest.fn(),
    executeKw: jest.fn(),
  };
  const audit: jest.Mocked<
    Pick<AuditService, 'recordModulesSelectionChanged' | 'recordTenantTrialRestricted'>
  > = {
    recordModulesSelectionChanged: jest.fn(),
    recordTenantTrialRestricted: jest.fn().mockResolvedValue(undefined),
  };
  let subscriptionStatus = SubscriptionStatus.ACTIVE;
  let callerRoles = ['WorkspaceOwner'];
  const contract = new OpenApiContractValidator();
  const entitlements = {
    isFeatureFlagEnabled: jest.fn().mockResolvedValue(true),
    getEntitlementSet: jest.fn().mockResolvedValue({
      planId: PLAN_ID,
      features: [{ key: 'module.accounting', enabled: true, limitValue: null }],
      trialWindowDays: 14,
      autoRestrictUnpaid: true,
      featureFlags: [],
    }),
    getEntitlementSetForAccount: jest.fn().mockResolvedValue({
      planId: PLAN_ID,
      features: [{ key: 'module.accounting', enabled: true, limitValue: null }],
      trialWindowDays: 14,
      autoRestrictUnpaid: true,
      featureFlags: [],
    }),
  };

  beforeAll(async () => {
    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: unknown) => {
      if (target === Account) {
        return repository({
          id: ACCOUNT_ID,
          keycloakUserId: SUBJECT_ID,
          emailVerified: true,
        }) as never;
      }
      if (target === Tenant) {
        return repository({
          id: TENANT_ID,
          accountId: ACCOUNT_ID,
          status: TenantStatus.READY,
          odooDbName: `t073_${TENANT_ID}`,
          readyAt: new Date(),
        }) as never;
      }
      if (target === Subscription) {
        return repositoryFactory(() => ({
          tenantId: TENANT_ID,
          planId: PLAN_ID,
          status: subscriptionStatus,
        })) as never;
      }
      if (target === Plan) {
        return {
          find: jest
            .fn()
            .mockResolvedValue([
              { id: PLAN_ID, name: 'Starter', nameEn: 'Starter', createdAt: new Date(0) },
            ]),
        } as never;
      }
      if (target === Feature) {
        return {
          find: jest.fn().mockResolvedValue([
            {
              key: 'module.accounting',
              displayName: 'Accounting',
              displayNameEn: 'Accounting',
              displayNameAr: 'المحاسبة',
              kind: FeatureKind.MODULE,
            },
          ]),
        } as never;
      }
      throw new Error(`Unexpected T073 repository: ${String(target)}`);
    });

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule, EntitlementsModule, ModuleSelectionModule],
      providers: [
        // Root-level TrialWindowGuard needs the token here; the builder override below
        // also replaces AuditModule's imported provider used by ModuleSelectionService.
        { provide: AuditService, useValue: audit },
        { provide: APP_GUARD, useClass: RoleGuard },
        { provide: APP_GUARD, useClass: FeatureFlagGuard },
        { provide: APP_GUARD, useClass: TrialWindowGuard },
      ],
    })
      // TrialWindowGuard and module selection stay real. Override only the imported
      // AuditModule provider so this synthetic-repository suite cannot hit AuditEvent.
      .overrideProvider(AuditService)
      .useValue(audit)
      .overrideProvider(EntitlementsService)
      .useValue(entitlements)
      .overrideProvider(OdooRpcService)
      .useValue(odoo)
      .compile();

    app = moduleRef.createNestApplication();
    app.use((req: { auth?: unknown }, _res: unknown, next: () => void) => {
      req.auth = { keycloakUserId: SUBJECT_ID, roles: callerRoles, tenantId: TENANT_ID };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ errorHttpStatusCode: 422, whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    subscriptionStatus = SubscriptionStatus.ACTIVE;
    callerRoles = ['WorkspaceOwner'];
    entitlements.isFeatureFlagEnabled.mockResolvedValue(true);
    entitlements.getEntitlementSetForAccount.mockResolvedValue({
      planId: PLAN_ID,
      features: [{ key: 'module.accounting', enabled: true, limitValue: null }],
      trialWindowDays: 14,
      autoRestrictUnpaid: true,
      featureFlags: [],
    });
    entitlements.getEntitlementSet.mockResolvedValue({
      planId: PLAN_ID,
      features: [{ key: 'module.accounting', enabled: true, limitValue: null }],
      trialWindowDays: 14,
      autoRestrictUnpaid: true,
      featureFlags: [],
    });
  });

  it('denies the documented UI-shaped call when any selected feature is not entitled', async () => {
    const response = await request(app.getHttpServer())
      .put('/modules/selection')
      .set('Origin', 'http://kemfai.test')
      .send({ featureKeys: ['module.accounting', 'module.inventory'] })
      .expect(403);

    expect(response.body.message).toBe('One or more selected modules require a different plan');
    expect(response.body.featureKeys).toEqual(['module.inventory']);
    expect(() =>
      contract.assertResponse('/modules/selection', 'put', response.status, response.body),
    ).not.toThrow();
    expect(odoo.authenticate).not.toHaveBeenCalled();
    expect(odoo.executeKw).not.toHaveBeenCalled();
    expect(audit.recordModulesSelectionChanged).not.toHaveBeenCalled();
  });

  it('denies an equivalent raw HTTP replay before Odoo persistence', async () => {
    const response = await request(app.getHttpServer())
      .put('/modules/selection')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ featureKeys: ['module.inventory'] }))
      .expect(403);

    expect(() =>
      contract.assertResponse('/modules/selection', 'put', response.status, response.body),
    ).not.toThrow();

    expect(odoo.authenticate).not.toHaveBeenCalled();
    expect(odoo.executeKw).not.toHaveBeenCalled();
    expect(audit.recordModulesSelectionChanged).not.toHaveBeenCalled();
  });

  it('denies an entitled non-module LIMIT key replay before Odoo persistence', async () => {
    entitlements.getEntitlementSetForAccount.mockResolvedValue({
      planId: PLAN_ID,
      features: [{ key: 'report.export', enabled: true, limitValue: 100 }],
      trialWindowDays: 14,
      autoRestrictUnpaid: true,
      featureFlags: [],
    });

    const response = await request(app.getHttpServer())
      .put('/modules/selection')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ featureKeys: ['report.export'] }))
      .expect(403);

    contract.assertResponse('/modules/selection', 'put', response.status, response.body);
    expect(response.body).toEqual({
      message: 'One or more selected modules require a different plan',
      featureKeys: ['report.export'],
    });
    expect(odoo.authenticate).not.toHaveBeenCalled();
    expect(odoo.executeKw).not.toHaveBeenCalled();
    expect(audit.recordModulesSelectionChanged).not.toHaveBeenCalled();
  });

  it('RoleGuard denies a caller without WorkspaceOwner before persistence', async () => {
    callerRoles = [];

    const response = await request(app.getHttpServer())
      .put('/modules/selection')
      .send({ featureKeys: ['module.accounting'] })
      .expect(403);

    contract.assertResponse('/modules/selection', 'put', response.status, response.body);
    expect(odoo.authenticate).not.toHaveBeenCalled();
  });

  it('FeatureFlagGuard hides the disabled module-selection surface', async () => {
    entitlements.isFeatureFlagEnabled.mockResolvedValue(false);

    await request(app.getHttpServer())
      .put('/modules/selection')
      .send({ featureKeys: ['module.accounting'] })
      .expect(404);

    expect(odoo.authenticate).not.toHaveBeenCalled();
  });

  it('returns actual HTTP 200 and persists/audits an entitled selection', async () => {
    odoo.authenticate.mockResolvedValue(7);
    odoo.executeKw.mockImplementation(async (...args: unknown[]) => {
      if (args[4] === 'kemfai_ack_selection_event') return true;
      const rpcArgs = args[5] as unknown[];
      return {
        operationUuid: rpcArgs[1],
        tenantId: TENANT_ID,
        accountId: ACCOUNT_ID,
        actorKeycloakUserId: SUBJECT_ID,
        occurredAt: '2026-10-17 08:00:00',
        featureKeys: ['module.accounting'],
        added: ['module.accounting'],
        removed: [],
      };
    });
    audit.recordModulesSelectionChanged.mockResolvedValue(undefined);

    const response = await request(app.getHttpServer())
      .put('/modules/selection')
      .send({ featureKeys: ['module.accounting'] })
      .expect(200);

    expect(response.body).toEqual({ featureKeys: ['module.accounting'] });
    expect(() =>
      contract.assertResponse('/modules/selection', 'put', response.status, response.body),
    ).not.toThrow();
    expect(odoo.executeKw).toHaveBeenCalledWith(
      `t073_${TENANT_ID}`,
      7,
      expect.any(String),
      'kemfai.module.selection',
      'kemfai_replace_selection',
      [
        ['module.accounting'],
        expect.any(String),
        TENANT_ID,
        ACCOUNT_ID,
        SUBJECT_ID,
        expect.any(String),
      ],
    );
    expect(audit.recordModulesSelectionChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        tenantId: TENANT_ID,
        added: ['module.accounting'],
        removed: [],
        operationUuid: expect.any(String),
      }),
    );
  });

  it('GET /modules returns an actual schema-shaped HTTP 200 response', async () => {
    odoo.authenticate.mockResolvedValue(7);
    odoo.executeKw.mockResolvedValue(['module.accounting']);
    const response = await request(app.getHttpServer()).get('/modules').expect(200);

    expect(response.body).toEqual([
      {
        key: 'module.accounting',
        name: 'Accounting',
        nameAr: 'المحاسبة',
        includedInCurrentPlan: true,
        selected: true,
        requiredPlanTier: null,
        requiredPlanTierAr: null,
      },
    ]);
    expect(() =>
      contract.assertResponse('/modules', 'get', response.status, response.body),
    ).not.toThrow();
  });

  it.each([
    [
      'UI-shaped',
      (call: request.Test) =>
        call.set('Origin', 'http://kemfai.test').send({ featureKeys: ['module.accounting'] }),
    ],
    [
      'raw replay',
      (call: request.Test) =>
        call
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ featureKeys: ['module.accounting'] })),
    ],
  ])(
    'TrialWindowGuard denies an elapsed unpaid %s call before persistence',
    async (_label, shape) => {
      subscriptionStatus = SubscriptionStatus.PENDING_ACTIVATION;
      entitlements.getEntitlementSet.mockResolvedValue({
        planId: PLAN_ID,
        features: [{ key: 'module.accounting', enabled: true, limitValue: null }],
        trialWindowDays: -1,
        autoRestrictUnpaid: true,
        featureFlags: [],
      });

      await shape(request(app.getHttpServer()).put('/modules/selection')).expect(403);

      expect(odoo.authenticate).not.toHaveBeenCalled();
      expect(odoo.executeKw).not.toHaveBeenCalled();
    },
  );
});

function repository(value: unknown) {
  return {
    findOne: jest.fn().mockResolvedValue(value),
    findOneBy: jest.fn().mockResolvedValue(value),
  };
}

function repositoryFactory(factory: () => unknown) {
  return {
    findOne: jest.fn(async () => factory()),
    findOneBy: jest.fn(async () => factory()),
  };
}
