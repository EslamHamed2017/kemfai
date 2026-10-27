import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { Account } from '../accounts/entities/account.entity';
import { EntitlementDefault } from './entities/entitlement-default.entity';
import { FeatureFlag } from './entities/feature-flag.entity';
import { PlanFeatureEntitlement } from './entities/plan-feature-entitlement.entity';
import { PlanSetting } from './entities/plan-setting.entity';
import { EntitlementsService } from './entitlements.service';

/**
 * Pure unit coverage of the fallback rules (I1 remediation, analysis.md) without a real Postgres
 * connection: `controlDataSource.getRepository` is stubbed per-entity. DB-backed proof that the
 * schema itself behaves this way lives in test/integration/entitlements-service.integration-spec.ts.
 */
describe('EntitlementsService (T010, unit)', () => {
  const PLAN_ID = '11111111-1111-1111-1111-111111111111';

  function mockRepositories(options: {
    entitlements?: Partial<PlanFeatureEntitlement>[];
    setting?: Partial<PlanSetting> | null;
    defaults?: Partial<EntitlementDefault>;
    account?: Partial<Account> | null;
    featureFlags?: Partial<FeatureFlag>[];
  }) {
    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: any) => {
      if (target === PlanFeatureEntitlement) {
        return { find: jest.fn().mockResolvedValue(options.entitlements ?? []) } as any;
      }
      if (target === PlanSetting) {
        return { findOne: jest.fn().mockResolvedValue(options.setting ?? null) } as any;
      }
      if (target === EntitlementDefault) {
        return {
          findOneByOrFail: jest.fn().mockResolvedValue(
            options.defaults ?? {
              id: 1,
              defaultTrialWindowDays: 14,
              defaultAutoRestrictUnpaid: true,
            },
          ),
        } as any;
      }
      if (target === FeatureFlag) {
        return {
          find: jest.fn().mockResolvedValue(options.featureFlags ?? []),
          findOne: jest
            .fn()
            .mockImplementation(({ where: { featureKey } }) =>
              Promise.resolve(
                (options.featureFlags ?? []).find((flag) => flag.featureKey === featureKey) ?? null,
              ),
            ),
        } as any;
      }
      if (target === Account) {
        return {
          findOne: jest
            .fn()
            .mockResolvedValue(options.account === undefined ? null : options.account),
        } as any;
      }
      throw new Error(`Unexpected repository requested for ${String(target)}`);
    });
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves features, trialWindowDays, and autoRestrictUnpaid from an explicit PlanSetting override (no fallback)', async () => {
    mockRepositories({
      entitlements: [{ featureKey: 'module.accounting', enabled: true, limitValue: '100' }],
      setting: { trialWindowDays: 30, autoRestrictUnpaid: false },
    });

    const result = await new EntitlementsService().getEntitlementSet(PLAN_ID);

    expect(result).toEqual({
      planId: PLAN_ID,
      features: [{ key: 'module.accounting', enabled: true, limitValue: 100 }],
      trialWindowDays: 30,
      autoRestrictUnpaid: false,
      featureFlags: [],
    });
  });

  it('falls back to EntitlementDefault.default_trial_window_days when PlanSetting.trial_window_days is null, independently of autoRestrictUnpaid', async () => {
    mockRepositories({
      setting: { trialWindowDays: null, autoRestrictUnpaid: false },
      defaults: { id: 1, defaultTrialWindowDays: 14, defaultAutoRestrictUnpaid: true },
    });

    const result = await new EntitlementsService().getEntitlementSet(PLAN_ID);

    expect(result.trialWindowDays).toBe(14);
    expect(result.autoRestrictUnpaid).toBe(false);
  });

  it('falls back to EntitlementDefault.default_auto_restrict_unpaid when PlanSetting.auto_restrict_unpaid is null, independently of trialWindowDays', async () => {
    mockRepositories({
      setting: { trialWindowDays: 45, autoRestrictUnpaid: null },
      defaults: { id: 1, defaultTrialWindowDays: 14, defaultAutoRestrictUnpaid: true },
    });

    const result = await new EntitlementsService().getEntitlementSet(PLAN_ID);

    expect(result.trialWindowDays).toBe(45);
    expect(result.autoRestrictUnpaid).toBe(true);
  });

  it('falls back to both EntitlementDefault fields when no PlanSetting row exists for the plan at all', async () => {
    mockRepositories({
      setting: null,
      defaults: { id: 1, defaultTrialWindowDays: 14, defaultAutoRestrictUnpaid: true },
    });

    const result = await new EntitlementsService().getEntitlementSet(PLAN_ID);

    expect(result.trialWindowDays).toBe(14);
    expect(result.autoRestrictUnpaid).toBe(true);
  });

  it('maps a null limitValue on PlanFeatureEntitlement to a null EntitlementSet feature limitValue', async () => {
    mockRepositories({
      entitlements: [{ featureKey: 'module.reports', enabled: true, limitValue: null }],
      setting: { trialWindowDays: 14, autoRestrictUnpaid: true },
    });

    const result = await new EntitlementsService().getEntitlementSet(PLAN_ID);

    expect(result.features).toEqual([{ key: 'module.reports', enabled: true, limitValue: null }]);
  });

  it('exposes per-feature flag state on getEntitlementSet (T099)', async () => {
    mockRepositories({
      setting: { trialWindowDays: 14, autoRestrictUnpaid: true },
      featureFlags: [
        { featureKey: 'module.reports', enabled: true, notes: null },
        { featureKey: 'module.checklist', enabled: false, notes: 'US7 — gate until Polish sweep' },
      ],
    });

    const result = await new EntitlementsService().getEntitlementSet(PLAN_ID);

    expect(result.featureFlags).toEqual([
      { key: 'module.reports', enabled: true },
      { key: 'module.checklist', enabled: false },
    ]);
  });

  it('getFeatureFlags returns an empty array when no FeatureFlag rows exist', async () => {
    mockRepositories({ featureFlags: [] });

    const result = await new EntitlementsService().getFeatureFlags();

    expect(result).toEqual([]);
  });

  it('isFeatureFlagEnabled reflects the stored enabled value for a gated feature', async () => {
    mockRepositories({
      featureFlags: [{ featureKey: 'module.checklist', enabled: false, notes: null }],
    });

    await expect(new EntitlementsService().isFeatureFlagEnabled('module.checklist')).resolves.toBe(
      false,
    );
  });

  it('isFeatureFlagEnabled fails closed when a required FeatureFlag row is missing', async () => {
    mockRepositories({ featureFlags: [] });

    await expect(new EntitlementsService().isFeatureFlagEnabled('module.not-gated')).resolves.toBe(
      false,
    );
  });

  it('resolves the plan via the account linked to the given keycloakUserId, not any client-supplied value', async () => {
    mockRepositories({
      setting: { trialWindowDays: 14, autoRestrictUnpaid: true },
      account: {
        id: 'account-1',
        keycloakUserId: '66666666-6666-4666-8666-666666666666',
        selectedPlanId: PLAN_ID,
      },
    });

    const result = await new EntitlementsService().getEntitlementSetForAccount(
      '66666666-6666-4666-8666-666666666666',
    );

    expect(result.planId).toBe(PLAN_ID);
  });

  it('rejects when no account is linked to the authenticated keycloakUserId', async () => {
    mockRepositories({ account: null });

    await expect(
      new EntitlementsService().getEntitlementSetForAccount('unknown-kc-user'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the linked account has not selected a plan yet', async () => {
    mockRepositories({
      account: {
        id: 'account-1',
        keycloakUserId: '66666666-6666-4666-8666-666666666666',
        selectedPlanId: null,
      },
    });

    await expect(
      new EntitlementsService().getEntitlementSetForAccount('66666666-6666-4666-8666-666666666666'),
    ).rejects.toThrow(NotFoundException);
  });
});
