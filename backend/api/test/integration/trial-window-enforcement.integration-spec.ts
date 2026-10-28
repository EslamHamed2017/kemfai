import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import { QUEUE_TRIAL_EXPIRY_SWEEP } from '../../src/common/queues/queue-names';
import controlDataSource from '../../src/database/data-source';
import { OdooRpcService } from '../../src/integrations/odoo-rpc/odoo-rpc.service';
import { TrialExpirySweepProcessor } from '../../src/integrations/provisioning/trial-expiry-sweep.processor';
import { Account, BillingCycle } from '../../src/modules/accounts/entities/account.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import { computeCompanySetupScope } from '../../src/modules/company-setup/company-setup-scope.util';
import { AuditActorType, AuditEvent } from '../../src/modules/audit/entities/audit-event.entity';
import { AuditService, TenantTrialRestrictedInput } from '../../src/modules/audit/audit.service';
import { Feature, FeatureKind } from '../../src/modules/entitlements/entities/feature.entity';
import { PlanFeatureEntitlement } from '../../src/modules/entitlements/entities/plan-feature-entitlement.entity';
import { PlanSetting } from '../../src/modules/entitlements/entities/plan-setting.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { EntitlementsService } from '../../src/modules/entitlements/entitlements.service';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

type CallShape = 'ui' | 'raw';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TRIAL_RESTRICTED_ACTION = 'tenant.trial.restricted';
const MODULE_SELECTION_ACTION = 'modules.selection.changed';
const REQUIRED_FLAGS = [
  'module.company_setup',
  'module.module_selection',
  'module.onboarding_checklist',
] as const;
const FIXED_SWEEP_NOW = Date.parse('2026-10-25T00:00:00.000Z');

interface FixturePrincipal {
  accountId: string;
  keycloakUserId: string;
  tenantId: string;
  subscriptionId: string;
}

/**
 * Forces both same-tick processors past their independent read-before-write checks before
 * either real AuditService insert starts. Persistence is not mocked: both calls continue into
 * AuditService and PostgreSQL. This makes the exact race T111 is required to detect
 * deterministic while leaving the production worker and database convergence path intact.
 */
class ConcurrentAuditBarrier extends AuditService {
  private arrivals = 0;
  private release!: () => void;
  private readonly bothArrived = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  override async recordTenantTrialRestricted(input: TenantTrialRestrictedInput): Promise<void> {
    this.arrivals += 1;
    if (this.arrivals === 2) this.release();
    await this.bothArrived;
    await super.recordTenantTrialRestricted(input);
  }
}

/**
 * T111 / FR-030a cross-cutting acceptance.
 *
 * The production AppModule, global guard order, controllers, services, EntitlementsService,
 * AuditService, and control-plane PostgreSQL are real. A local RS256/JWKS fixture exercises the
 * production BearerAuthGuard. OdooRpcService is the sole overridden provider: it is an external
 * seam, and its strict stateful replies allow every bypass positive control to traverse the real
 * controller/service path without importing a separate Odoo live stack. Sweep idempotency never
 * relies on that seam and is asserted against real persisted audit_event rows.
 */
describe('FR-030a trial-window enforcement across every onboarding path (T111)', () => {
  const issuer = 'http://127.0.0.1/realms/kemfai-customers-t111';
  const audience = 'kemfai-api-t111';
  const testFeatureKey = 'module.t111-positive-control';
  const originalEnvironment = {
    issuer: process.env.KEYCLOAK_ISSUER,
    audience: process.env.KEYCLOAK_API_AUDIENCE,
    jwksUri: process.env.KEYCLOAK_JWKS_URI,
    mutationWorker: process.env.KEMFAI_DISABLE_MUTATION_RECOVERY_WORKER,
    moduleSelectionWorker: process.env.KEMFAI_DISABLE_MODULE_SELECTION_RECOVERY_WORKER,
  };

  let app: INestApplication | undefined;
  let appClosed = false;
  let keycloak: FakeKeycloak | undefined;
  let ownerToken = '';
  let setupScope = '';
  let restrictivePlanId = '';
  let nonRestrictivePlanId = '';
  let primary: FixturePrincipal;
  let activeControl: FixturePrincipal;
  let nonRestrictiveControl: FixturePrincipal;
  let originalFlagStates: Array<{ feature_key: string; enabled: boolean }> = [];

  const authenticate = jest.fn(async (): Promise<number> => 7);
  const executeKw = jest.fn(
    async (
      _database: string,
      _uid: number,
      _password: string,
      model: string,
      method: string,
      args: unknown[] = [],
    ): Promise<unknown> => {
      if (model === 'res.company' && method === 'kemfai_setup_get_state') {
        return setupState({}, 0);
      }
      if (model === 'res.company' && method === 'kemfai_setup_save_step') {
        const values = isRecord(args[2]) ? args[2] : {};
        const baseVersion = typeof args[3] === 'number' ? args[3] : 0;
        return setupState(values, baseVersion + 1);
      }
      if (model === 'kemfai.module.selection' && method === 'kemfai_replace_selection') {
        const featureKeys = stringArray(args[0], 'module-selection featureKeys');
        const operationUuid = stringValue(args[1], 'module-selection operationUuid');
        return {
          operationUuid,
          tenantId: stringValue(args[2], 'module-selection tenantId'),
          accountId: stringValue(args[3], 'module-selection accountId'),
          actorKeycloakUserId: stringValue(args[4], 'module-selection actorKeycloakUserId'),
          occurredAt: stringValue(args[5], 'module-selection occurredAt'),
          featureKeys,
          added: featureKeys,
          removed: [],
        };
      }
      if (model === 'kemfai.module.selection' && method === 'kemfai_ack_selection_event') {
        return true;
      }
      if (model === 'kemfai.onboarding.checklist' && method === 'kemfai_get_state') {
        return {
          customerAdded: false,
          bankAdded: false,
          productAdded: false,
          firstInvoiceReady: false,
        };
      }
      if (model === 'kemfai.module.selection' && method === 'kemfai_get_pending_selection_event') {
        return false;
      }
      throw new Error(`Unexpected synthetic Odoo call: ${model}.${method}`);
    },
  );
  const syntheticOdoo = { authenticate, executeKw };

  beforeAll(async () => {
    process.env.KEMFAI_DISABLE_MUTATION_RECOVERY_WORKER = '1';
    process.env.KEMFAI_DISABLE_MODULE_SELECTION_RECOVERY_WORKER = '1';

    if (!controlDataSource.isInitialized) await controlDataSource.initialize();
    await controlDataSource.runMigrations();

    originalFlagStates = (await controlDataSource.query(
      'SELECT feature_key, enabled FROM feature_flag WHERE feature_key = ANY($1::text[])',
      [REQUIRED_FLAGS],
    )) as Array<{ feature_key: string; enabled: boolean }>;
    expect(originalFlagStates).toHaveLength(REQUIRED_FLAGS.length);
    await controlDataSource.query(
      'UPDATE feature_flag SET enabled = true WHERE feature_key = ANY($1::text[])',
      [REQUIRED_FLAGS],
    );

    const featureRepository = controlDataSource.getRepository(Feature);
    await featureRepository.save(
      featureRepository.create({
        key: testFeatureKey,
        displayName: 'T111 positive-control module',
        displayNameEn: 'T111 positive-control module',
        displayNameAr: null,
        kind: FeatureKind.MODULE,
      }),
    );

    restrictivePlanId = await createPlan('restrictive', true);
    nonRestrictivePlanId = await createPlan('non-restrictive', false);
    await controlDataSource.getRepository(PlanFeatureEntitlement).save({
      planId: restrictivePlanId,
      featureKey: testFeatureKey,
      enabled: true,
      limitValue: null,
    });

    // Primary starts Active so AppModule initialization cannot create the trial audit before
    // the six explicit denial cases arrange their own expired/non-Active precondition.
    primary = await createPrincipal('primary', restrictivePlanId, SubscriptionStatus.ACTIVE);
    activeControl = await createPrincipal(
      'active-control',
      restrictivePlanId,
      SubscriptionStatus.ACTIVE,
    );
    nonRestrictiveControl = await createPrincipal(
      'nonrestrict-control',
      nonRestrictivePlanId,
      SubscriptionStatus.PENDING_ACTIVATION,
    );

    keycloak = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OdooRpcService)
      .useValue(syntheticOdoo)
      .compile();
    app = moduleRef.createNestApplication();
    // Pause this isolated fixture's queue before Nest lifecycle hooks run. Pausing after listen()
    // left a real scheduler tick racing the first HTTP precondition on slower fresh databases.
    // The production processor remains real and is invoked explicitly by the sweep assertions.
    await moduleRef.get<Queue>(getQueueToken(QUEUE_TRIAL_EXPIRY_SWEEP)).pause();
    await app.listen(0, '127.0.0.1');

    ownerToken = await keycloak.signAccessToken({
      sub: primary.keycloakUserId,
      roles: ['WorkspaceOwner'],
      tenantId: primary.tenantId,
    });

    // The setup precondition is obtained through the real documented GET flow rather than
    // fabricated by the caller. Its equality to the server computation also proves that the
    // account/tenant/company fixture is internally coherent before any PUT assertion runs.
    const setup = await request(httpServer())
      .get('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Accept', 'application/json')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Requested-With', 'XMLHttpRequest')
      .expect(200);
    setupScope = setup.body.scope as string;
    expect(setupScope).toBe(
      computeCompanySetupScope(primary.tenantId, primary.accountId, companyIdFor('primary')),
    );
  }, 120_000);

  beforeEach(async () => {
    authenticate.mockClear();
    executeKw.mockClear();
    await setPrimarySubscription(SubscriptionStatus.PENDING_ACTIVATION);
    await setPrimaryTrialConfig(true, 1);
    await setReadyAt(primary.tenantId, new Date(Date.now() - 10 * MS_PER_DAY));
    await controlDataSource.getRepository(AuditEvent).delete({
      tenantId: primary.tenantId,
      action: TRIAL_RESTRICTED_ACTION,
    });
  });

  afterAll(async () => {
    let cleanupError: unknown;
    const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        cleanupError ??= error;
      }
    };

    if (app && !appClosed) await attempt(() => app!.close());
    if (keycloak) await attempt(() => keycloak!.close());

    if (controlDataSource.isInitialized) {
      const principals = [primary, activeControl, nonRestrictiveControl].filter(
        (value): value is FixturePrincipal => Boolean(value),
      );
      const tenantIds = principals.map((value) => value.tenantId);
      const subscriptionIds = principals.map((value) => value.subscriptionId);
      const accountIds = principals.map((value) => value.accountId);

      if (tenantIds.length > 0) {
        await attempt(() =>
          controlDataSource.query('DELETE FROM audit_event WHERE tenant_id = ANY($1::uuid[])', [
            tenantIds,
          ]),
        );
      }
      if (subscriptionIds.length > 0) {
        await attempt(() =>
          controlDataSource.query('DELETE FROM subscription WHERE id = ANY($1::uuid[])', [
            subscriptionIds,
          ]),
        );
      }
      if (tenantIds.length > 0) {
        await attempt(() =>
          controlDataSource.query('DELETE FROM tenant WHERE id = ANY($1::uuid[])', [tenantIds]),
        );
      }
      if (accountIds.length > 0) {
        await attempt(() =>
          controlDataSource.query('DELETE FROM account WHERE id = ANY($1::uuid[])', [accountIds]),
        );
      }
      const planIds = [restrictivePlanId, nonRestrictivePlanId].filter(Boolean);
      if (planIds.length > 0) {
        await attempt(() =>
          controlDataSource.query('DELETE FROM plan WHERE id = ANY($1::uuid[])', [planIds]),
        );
      }
      await attempt(() =>
        controlDataSource.query('DELETE FROM feature WHERE key = $1', [testFeatureKey]),
      );
      for (const row of originalFlagStates) {
        await attempt(() =>
          controlDataSource.query('UPDATE feature_flag SET enabled = $1 WHERE feature_key = $2', [
            row.enabled,
            row.feature_key,
          ]),
        );
      }
      await attempt(async () => {
        expect(await fixtureResidueCount()).toBe(0);
      });
      await attempt(() => controlDataSource.destroy());
    }

    restoreEnvironment('KEYCLOAK_ISSUER', originalEnvironment.issuer);
    restoreEnvironment('KEYCLOAK_API_AUDIENCE', originalEnvironment.audience);
    restoreEnvironment('KEYCLOAK_JWKS_URI', originalEnvironment.jwksUri);
    restoreEnvironment(
      'KEMFAI_DISABLE_MUTATION_RECOVERY_WORKER',
      originalEnvironment.mutationWorker,
    );
    restoreEnvironment(
      'KEMFAI_DISABLE_MODULE_SELECTION_RECOVERY_WORKER',
      originalEnvironment.moduleSelectionWorker,
    );

    if (cleanupError) throw cleanupError;
  }, 60_000);

  it('denies PUT /companies/current/setup through the documented UI-shaped call', async () => {
    await expectTrialDenial(setupCall('ui'));
  });

  it('denies PUT /companies/current/setup through a raw HTTP replay', async () => {
    await expectTrialDenial(setupCall('raw'));
  });

  it('denies PUT /modules/selection through the documented UI-shaped call', async () => {
    await expectTrialDenial(moduleSelectionCall('ui'));
  });

  it('denies PUT /modules/selection through a raw HTTP replay', async () => {
    await expectTrialDenial(moduleSelectionCall('raw'));
  });

  it('denies GET /onboarding/checklist through the documented UI-shaped call', async () => {
    await expectTrialDenial(checklistCall('ui'));
  });

  it('denies GET /onboarding/checklist through a raw HTTP replay', async () => {
    await expectTrialDenial(checklistCall('raw'));
  });

  it('an Active Subscription bypasses restriction on all three paths and both call shapes', async () => {
    await setPrimarySubscription(SubscriptionStatus.ACTIVE);
    await expectAllPathsAllowed(false);
  });

  it('resolved autoRestrictUnpaid=false bypasses restriction on all three paths and both call shapes', async () => {
    await setPrimaryTrialConfig(false, 1);
    await expectAllPathsAllowed(true);
  });

  it('the exact resolved trial boundary remains allowed on all three paths and both call shapes', async () => {
    const boundaryNow = Date.now();
    await setReadyAt(primary.tenantId, new Date(boundaryNow - MS_PER_DAY));
    const now = jest.spyOn(Date, 'now').mockReturnValue(boundaryNow);
    try {
      await expectAllPathsAllowed(true);
    } finally {
      now.mockRestore();
    }
  });

  it("a caller cannot borrow another tenant's non-restrictive plan through a tenant header", async () => {
    const before = await trialAuditCount(primary.tenantId);
    const response = await checklistCall('ui')
      .set('X-Tenant-Id', nonRestrictiveControl.tenantId)
      .expect(403);

    expect(response.body).toEqual({
      message: 'Request denied: tenant scope violation',
      error: 'Forbidden',
      statusCode: 403,
    });
    expect(await trialAuditCount(primary.tenantId)).toBe(before);
    expect(authenticate).not.toHaveBeenCalled();
    expect(executeKw).not.toHaveBeenCalled();
    expect(
      await controlDataSource.getRepository(AuditEvent).countBy({
        tenantId: primary.tenantId,
        action: 'tenant_access.denied_cross_tenant',
        subjectId: nonRestrictiveControl.tenantId,
      }),
    ).toBe(1);
  });

  it('the live guard and repeated same-tick sweep converge on the same persisted audit event', async () => {
    await expectTrialDenial(checklistCall('raw'));
    const [guardEvent] = await trialAuditEvents(primary.tenantId);

    await arrangeSweepControls();
    const now = jest.spyOn(Date, 'now').mockReturnValue(FIXED_SWEEP_NOW);
    try {
      const processor = new TrialExpirySweepProcessor(
        new AuditService(),
        new EntitlementsService(),
      );
      const job = {} as never;
      await processor.process(job);
      await processor.process(job);
    } finally {
      now.mockRestore();
    }

    const afterSweep = await trialAuditEvents(primary.tenantId);
    expect(afterSweep).toHaveLength(1);
    expect(afterSweep[0].id).toBe(guardEvent.id);
    expect(afterSweep[0].dedupeKey).toBe(`tenant-trial-restricted:${primary.tenantId}`);
  });

  it('two concurrent same-tick trial.expiry_sweep runs and a repeat persist one linked audit only', async () => {
    await closeHttpAppBeforeSweep();
    await controlDataSource.getRepository(AuditEvent).delete({
      tenantId: primary.tenantId,
      action: TRIAL_RESTRICTED_ACTION,
    });
    await arrangeSweepControls();
    const beforeTenant = await controlDataSource
      .getRepository(Tenant)
      .findOneByOrFail({ id: primary.tenantId });
    const beforeSubscription = await controlDataSource
      .getRepository(Subscription)
      .findOneByOrFail({ id: primary.subscriptionId });
    const now = jest.spyOn(Date, 'now').mockReturnValue(FIXED_SWEEP_NOW);
    try {
      const processor = new TrialExpirySweepProcessor(
        new ConcurrentAuditBarrier(),
        new EntitlementsService(),
      );
      const job = {} as never;
      await Promise.all([processor.process(job), processor.process(job)]);
      await processor.process(job);
    } finally {
      now.mockRestore();
    }

    const events = await controlDataSource.getRepository(AuditEvent).findBy({
      tenantId: primary.tenantId,
      action: TRIAL_RESTRICTED_ACTION,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: AuditActorType.SYSTEM,
      actorId: null,
      tenantId: primary.tenantId,
      action: TRIAL_RESTRICTED_ACTION,
      subjectType: 'tenant',
      subjectId: primary.tenantId,
      payload: {
        trial_window_days: 1,
        elapsed_days: 2,
        auto_restrict_unpaid: true,
      },
      dedupeKey: `tenant-trial-restricted:${primary.tenantId}`,
    });
    await expect(
      controlDataSource.getRepository(Tenant).findOneByOrFail({ id: events[0].subjectId }),
    ).resolves.toMatchObject({ id: primary.tenantId });
    expect(await trialAuditCount(activeControl.tenantId)).toBe(0);
    expect(await trialAuditCount(nonRestrictiveControl.tenantId)).toBe(0);

    const afterTenant = await controlDataSource
      .getRepository(Tenant)
      .findOneByOrFail({ id: primary.tenantId });
    const afterSubscription = await controlDataSource
      .getRepository(Subscription)
      .findOneByOrFail({ id: primary.subscriptionId });
    expect(afterTenant).toMatchObject({
      id: beforeTenant.id,
      status: beforeTenant.status,
      readyAt: beforeTenant.readyAt,
    });
    expect(afterSubscription).toMatchObject({
      id: beforeSubscription.id,
      status: beforeSubscription.status,
      planId: beforeSubscription.planId,
    });
  });

  it('a failed trial audit leaves no marker and the next sweep self-heals exactly once', async () => {
    await closeHttpAppBeforeSweep();
    await controlDataSource.getRepository(AuditEvent).delete({
      tenantId: primary.tenantId,
      action: TRIAL_RESTRICTED_ACTION,
    });
    await arrangeSweepControls();
    const failingAudit = {
      recordTenantTrialRestricted: async () => {
        throw new Error('synthetic T111 audit failure');
      },
    } as unknown as AuditService;
    const now = jest.spyOn(Date, 'now').mockReturnValue(FIXED_SWEEP_NOW);
    try {
      const job = {} as never;
      await expect(
        new TrialExpirySweepProcessor(failingAudit, new EntitlementsService()).process(job),
      ).rejects.toThrow('synthetic T111 audit failure');
      expect(await trialAuditCount(primary.tenantId)).toBe(0);

      const retry = new TrialExpirySweepProcessor(new AuditService(), new EntitlementsService());
      await retry.process(job);
      await retry.process(job);
      expect(await trialAuditCount(primary.tenantId)).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  async function createPlan(label: string, autoRestrictUnpaid: boolean): Promise<string> {
    const planRepository = controlDataSource.getRepository(Plan);
    const plan = await planRepository.save(
      planRepository.create({
        name: `T111 ${label} ${randomUUID()}`,
        nameEn: `T111 ${label}`,
        nameAr: null,
        published: false,
        monthlyPrice: '10.00',
        annualPrice: '100.00',
        currency: 'USD',
      }),
    );
    await controlDataSource.getRepository(PlanSetting).save({
      planId: plan.id,
      trialWindowDays: 1,
      autoRestrictUnpaid,
    });
    return plan.id;
  }

  async function createPrincipal(
    label: string,
    planId: string,
    status: SubscriptionStatus,
  ): Promise<FixturePrincipal> {
    const keycloakUserId = randomUUID();
    const accountRepository = controlDataSource.getRepository(Account);
    const account = await accountRepository.save(
      accountRepository.create({
        keycloakUserId,
        email: `t111-${label}-${randomUUID()}@example.invalid`,
        emailVerified: true,
        mfaEnrolled: false,
        selectedPlanId: planId,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
    );
    const tenantRepository = controlDataSource.getRepository(Tenant);
    const tenant = await tenantRepository.save(
      tenantRepository.create({
        accountId: account.id,
        status: TenantStatus.READY,
        odooDbName: `t111_${label.replaceAll('-', '_')}`,
        odooCompanyId: companyIdFor(label),
        minioBucket: null,
        provisioningAttempts: 1,
        failureReason: null,
        readyAt: new Date(Date.now() - 10 * MS_PER_DAY),
      }),
    );
    const subscriptionRepository = controlDataSource.getRepository(Subscription);
    const subscription = await subscriptionRepository.save(
      subscriptionRepository.create({
        tenantId: tenant.id,
        planId,
        billingCycle: SubscriptionBillingCycle.MONTHLY,
        status,
        currentPeriodStart: '2026-10-01',
        currentPeriodEnd: '2026-10-31',
        activatedAt: status === SubscriptionStatus.ACTIVE ? new Date() : null,
        activatedBy: null,
      }),
    );
    return {
      accountId: account.id,
      keycloakUserId,
      tenantId: tenant.id,
      subscriptionId: subscription.id,
    };
  }

  function setupCall(shape: CallShape): request.Test {
    let call = request(httpServer())
      .put('/companies/current/setup')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-KEMFAI-Setup-Scope', setupScope);
    if (shape === 'ui') {
      call = call
        .set('Accept', 'application/json')
        .set('Origin', 'http://127.0.0.1')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ step: 'country', values: { country: 'AE' }, baseVersion: 0 });
    } else {
      call = call
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ step: 'country', values: { country: 'AE' }, baseVersion: 0 }));
    }
    return call;
  }

  function moduleSelectionCall(shape: CallShape): request.Test {
    let call = request(httpServer())
      .put('/modules/selection')
      .set('Authorization', `Bearer ${ownerToken}`);
    if (shape === 'ui') {
      call = call
        .set('Accept', 'application/json')
        .set('Origin', 'http://127.0.0.1')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ featureKeys: [testFeatureKey] });
    } else {
      call = call
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ featureKeys: [testFeatureKey] }));
    }
    return call;
  }

  function checklistCall(shape: CallShape): request.Test {
    let call = request(httpServer())
      .get('/onboarding/checklist')
      .set('Authorization', `Bearer ${ownerToken}`);
    if (shape === 'ui') {
      call = call
        .set('Accept', 'application/json')
        .set('Cache-Control', 'no-store')
        .set('Origin', 'http://127.0.0.1')
        .set('X-Requested-With', 'XMLHttpRequest');
    }
    return call;
  }

  async function expectTrialDenial(call: request.Test): Promise<void> {
    expect(await trialAuditCount(primary.tenantId)).toBe(0);
    const response = await call.expect(403);
    expect(response.body).toEqual({
      message: 'Trial window has ended; activate a subscription to continue',
      error: 'Forbidden',
      statusCode: 403,
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(executeKw).not.toHaveBeenCalled();
    const events = await trialAuditEvents(primary.tenantId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: AuditActorType.SYSTEM,
      actorId: null,
      tenantId: primary.tenantId,
      action: TRIAL_RESTRICTED_ACTION,
      subjectType: 'tenant',
      subjectId: primary.tenantId,
      payload: {
        trial_window_days: 1,
        elapsed_days: 10,
        auto_restrict_unpaid: true,
      },
      dedupeKey: `tenant-trial-restricted:${primary.tenantId}`,
    });
    await expect(
      controlDataSource.getRepository(Tenant).findOneByOrFail({ id: events[0].subjectId }),
    ).resolves.toMatchObject({ id: primary.tenantId });
  }

  async function expectAllPathsAllowed(expectActivationGate: boolean): Promise<void> {
    const moduleAuditCountBefore = await controlDataSource
      .getRepository(AuditEvent)
      .countBy({ tenantId: primary.tenantId, action: MODULE_SELECTION_ACTION });

    const setupUi = await setupCall('ui').expect(200);
    expect(setupUi.body).toMatchObject({
      currentStep: 'identity',
      setupComplete: false,
      values: { country: 'AE' },
      version: 1,
      stale: false,
      scope: setupScope,
    });

    const setupRaw = await setupCall('raw').expect(200);
    expect(setupRaw.body).toMatchObject({
      currentStep: 'identity',
      setupComplete: false,
      values: { country: 'AE' },
      version: 1,
      stale: false,
      scope: setupScope,
    });

    const modulesUi = await moduleSelectionCall('ui').expect(200);
    expect(modulesUi.body).toEqual({ featureKeys: [testFeatureKey] });

    const modulesRaw = await moduleSelectionCall('raw').expect(200);
    expect(modulesRaw.body).toEqual({ featureKeys: [testFeatureKey] });

    const checklistUi = await checklistCall('ui').expect(200);
    expect(checklistUi.body).toEqual({
      customerAdded: false,
      bankAdded: false,
      productAdded: false,
      firstInvoiceReady: false,
      gatedOnSubscriptionActivation: expectActivationGate,
    });

    const checklistRaw = await checklistCall('raw').expect(200);
    expect(checklistRaw.body).toEqual({
      customerAdded: false,
      bankAdded: false,
      productAdded: false,
      firstInvoiceReady: false,
      gatedOnSubscriptionActivation: expectActivationGate,
    });

    const persistedModuleAudits = await controlDataSource.getRepository(AuditEvent).findBy({
      tenantId: primary.tenantId,
      action: MODULE_SELECTION_ACTION,
    });
    expect(persistedModuleAudits).toHaveLength(moduleAuditCountBefore + 2);
    expect(
      persistedModuleAudits
        .slice(-2)
        .every(
          (event) =>
            event.subjectType === 'module_selection' &&
            event.subjectId === primary.tenantId &&
            event.actorId === primary.accountId,
        ),
    ).toBe(true);
    expect(await trialAuditCount(primary.tenantId)).toBe(0);
    expect(authenticate).toHaveBeenCalledTimes(6);
    expect(
      executeKw.mock.calls.filter((call) => call[4] === 'kemfai_setup_save_step'),
    ).toHaveLength(2);
    expect(
      executeKw.mock.calls.filter((call) => call[4] === 'kemfai_replace_selection'),
    ).toHaveLength(2);
    expect(executeKw.mock.calls.filter((call) => call[4] === 'kemfai_get_state')).toHaveLength(2);
  }

  async function arrangeSweepControls(): Promise<void> {
    await setPrimarySubscription(SubscriptionStatus.PENDING_ACTIVATION);
    await setPrimaryTrialConfig(true, 1);
    await setReadyAt(primary.tenantId, new Date(FIXED_SWEEP_NOW - 2 * MS_PER_DAY));
    await controlDataSource
      .getRepository(Subscription)
      .update({ id: activeControl.subscriptionId }, { status: SubscriptionStatus.ACTIVE });
    await setReadyAt(activeControl.tenantId, new Date(FIXED_SWEEP_NOW - 2 * MS_PER_DAY));
    await controlDataSource
      .getRepository(Subscription)
      .update(
        { id: nonRestrictiveControl.subscriptionId },
        { status: SubscriptionStatus.PENDING_ACTIVATION },
      );
    await setReadyAt(nonRestrictiveControl.tenantId, new Date(FIXED_SWEEP_NOW - 2 * MS_PER_DAY));
  }

  async function closeHttpAppBeforeSweep(): Promise<void> {
    if (app && !appClosed) {
      await app.close();
      appClosed = true;
    }
  }

  async function setPrimarySubscription(status: SubscriptionStatus): Promise<void> {
    await controlDataSource.getRepository(Subscription).update(
      { id: primary.subscriptionId },
      {
        status,
        activatedAt: status === SubscriptionStatus.ACTIVE ? new Date() : null,
      },
    );
  }

  async function setPrimaryTrialConfig(
    autoRestrictUnpaid: boolean,
    trialWindowDays: number,
  ): Promise<void> {
    await controlDataSource
      .getRepository(PlanSetting)
      .update({ planId: restrictivePlanId }, { autoRestrictUnpaid, trialWindowDays });
  }

  async function setReadyAt(tenantId: string, readyAt: Date): Promise<void> {
    await controlDataSource.getRepository(Tenant).update({ id: tenantId }, { readyAt });
  }

  async function trialAuditCount(tenantId: string): Promise<number> {
    return controlDataSource
      .getRepository(AuditEvent)
      .countBy({ tenantId, action: TRIAL_RESTRICTED_ACTION });
  }

  async function trialAuditEvents(tenantId: string): Promise<AuditEvent[]> {
    return controlDataSource
      .getRepository(AuditEvent)
      .findBy({ tenantId, action: TRIAL_RESTRICTED_ACTION });
  }

  function httpServer(): Parameters<typeof request>[0] {
    if (!app || appClosed) throw new Error('T111 HTTP app is not available');
    return app.getHttpServer() as Parameters<typeof request>[0];
  }

  async function fixtureResidueCount(): Promise<number> {
    const principals = [primary, activeControl, nonRestrictiveControl].filter(
      (value): value is FixturePrincipal => Boolean(value),
    );
    const tenantIds = principals.map((value) => value.tenantId);
    const accountIds = principals.map((value) => value.accountId);
    const subscriptionIds = principals.map((value) => value.subscriptionId);
    const planIds = [restrictivePlanId, nonRestrictivePlanId].filter(Boolean);
    const scalar = async (sql: string, parameters: unknown[]): Promise<number> => {
      const rows = (await controlDataSource.query(sql, parameters)) as Array<{ count: string }>;
      return Number(rows[0].count);
    };
    const counts = await Promise.all([
      scalar('SELECT count(*)::text count FROM audit_event WHERE tenant_id = ANY($1::uuid[])', [
        tenantIds,
      ]),
      scalar('SELECT count(*)::text count FROM subscription WHERE id = ANY($1::uuid[])', [
        subscriptionIds,
      ]),
      scalar('SELECT count(*)::text count FROM tenant WHERE id = ANY($1::uuid[])', [tenantIds]),
      scalar('SELECT count(*)::text count FROM account WHERE id = ANY($1::uuid[])', [accountIds]),
      scalar('SELECT count(*)::text count FROM plan WHERE id = ANY($1::uuid[])', [planIds]),
      scalar('SELECT count(*)::text count FROM feature WHERE key = $1', [testFeatureKey]),
    ]);
    return counts.reduce((total, count) => total + count, 0);
  }
});

function setupState(values: Record<string, unknown>, version: number) {
  return {
    currentStep: 'identity',
    setupComplete: false,
    values,
    version,
    stale: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  return value;
}

function companyIdFor(label: string): number {
  switch (label) {
    case 'primary':
      return 111;
    case 'active-control':
      return 112;
    case 'nonrestrict-control':
      return 113;
    default:
      throw new Error(`Unknown T111 fixture label: ${label}`);
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
