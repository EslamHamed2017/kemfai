import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { EntitlementsService } from '../../src/modules/entitlements/entitlements.service';
import { FeatureFlag } from '../../src/modules/entitlements/entities/feature-flag.entity';
import { Feature, FeatureKind } from '../../src/modules/entitlements/entities/feature.entity';
import { PlanFeatureEntitlement } from '../../src/modules/entitlements/entities/plan-feature-entitlement.entity';
import { PlanSetting } from '../../src/modules/entitlements/entities/plan-setting.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';

/**
 * T010 acceptance test. Requires a reachable, already-migrated Postgres configured via
 * CONTROL_DB_* env vars, same convention as T009's entitlements-migration.integration-spec.ts.
 * The `entitlement_default` singleton seeded by the migration itself is read but never mutated
 * or deleted here, so this suite is repeatable against an already-migrated database.
 */
describe('EntitlementsService (T010)', () => {
  const service = new EntitlementsService();

  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();
  });

  afterEach(async () => {
    await controlDataSource.query('DELETE FROM "account"');
    await controlDataSource.query('DELETE FROM "plan_feature_entitlement"');
    await controlDataSource.query('DELETE FROM "plan_setting"');
    // Never delete the permanently-shipped module gate rows (module.accounts,
    // module.company_setup) — they are seeded once by their own migrations, which never
    // re-run, so deleting them here would leave the platform's feature-flag rows gone for
    // every suite that runs afterward in the same test process (repeatability lesson).
    await controlDataSource.query(
      `DELETE FROM "feature_flag" WHERE "feature_key" NOT IN ('module.accounts', 'module.company_setup')`,
    );
    await controlDataSource.query(
      `DELETE FROM "feature" WHERE "key" NOT IN ('module.accounts', 'module.company_setup')`,
    );
    await controlDataSource.query('DELETE FROM "plan"');
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  async function createPlan(name: string) {
    const repo = controlDataSource.getRepository(Plan);
    return repo.save(
      repo.create({
        name,
        published: true,
        monthlyPrice: '49.00',
        annualPrice: '490.00',
        currency: 'USD',
      }),
    );
  }

  async function createFeature(key: string, kind: FeatureKind = FeatureKind.MODULE) {
    const repo = controlDataSource.getRepository(Feature);
    return repo.save(repo.create({ key, displayName: key, kind }));
  }

  it('resolves features, trialWindowDays, and autoRestrictUnpaid from an explicit PlanSetting override (no fallback)', async () => {
    // This assertion requires both shipped module gates to be in their disabled shipped
    // state. Another suite sharing this process/database (e.g. the T054 live HTTP harness)
    // may leave `module.company_setup` enabled if it runs first, so this test must establish
    // that state itself — rather than assume migration-seeded defaults survived — and restore
    // whatever it found afterward, so it passes regardless of suite execution order.
    const shippedDisabledKeys = ['module.accounts', 'module.company_setup'];
    const priorFlagRows = await controlDataSource.query(
      `SELECT feature_key, enabled FROM "feature_flag" WHERE feature_key = ANY($1)`,
      [shippedDisabledKeys],
    );
    await controlDataSource.query(
      `UPDATE "feature_flag" SET enabled = false WHERE feature_key = ANY($1)`,
      [shippedDisabledKeys],
    );
    try {
      const plan = await createPlan('override-plan');
      const feature = await createFeature('module.override-test');
      await controlDataSource.getRepository(PlanFeatureEntitlement).save({
        planId: plan.id,
        featureKey: feature.key,
        enabled: true,
        limitValue: '250',
      });
      await controlDataSource
        .getRepository(PlanSetting)
        .save({ planId: plan.id, trialWindowDays: 30, autoRestrictUnpaid: false });

      const result = await service.getEntitlementSet(plan.id);

      expect(result.planId).toBe(plan.id);
      expect(result.features).toEqual([{ key: feature.key, enabled: true, limitValue: 250 }]);
      expect(result.trialWindowDays).toBe(30);
      expect(result.autoRestrictUnpaid).toBe(false);
      // Feature flags are platform-wide (T099), and the platform permanently ships a growing
      // set of module gate rows via migration (`module.accounts` since T032, `module.company_setup`
      // since T042). This test creates no flags, so the only rows that may legitimately appear
      // are those shipped platform gates (in their shipped, disabled state) — never a
      // test-created flag.
      expect(result.featureFlags).toEqual(
        result.featureFlags.filter(
          (flag) => shippedDisabledKeys.includes(flag.key) && flag.enabled === false,
        ),
      );
    } finally {
      for (const row of priorFlagRows as Array<{ feature_key: string; enabled: boolean }>) {
        await controlDataSource.query(
          `UPDATE "feature_flag" SET enabled = $1 WHERE feature_key = $2`,
          [row.enabled, row.feature_key],
        );
      }
    }
  });

  it('falls back to EntitlementDefault.default_trial_window_days when PlanSetting.trial_window_days is null, independently of autoRestrictUnpaid', async () => {
    const plan = await createPlan('trial-fallback-plan');
    await controlDataSource
      .getRepository(PlanSetting)
      .save({ planId: plan.id, trialWindowDays: null, autoRestrictUnpaid: false });

    const result = await service.getEntitlementSet(plan.id);

    expect(result.trialWindowDays).toBe(14);
    expect(result.autoRestrictUnpaid).toBe(false);
  });

  it('falls back to EntitlementDefault.default_auto_restrict_unpaid when PlanSetting.auto_restrict_unpaid is null, independently of trialWindowDays', async () => {
    const plan = await createPlan('auto-restrict-fallback-plan');
    await controlDataSource
      .getRepository(PlanSetting)
      .save({ planId: plan.id, trialWindowDays: 45, autoRestrictUnpaid: null });

    const result = await service.getEntitlementSet(plan.id);

    expect(result.trialWindowDays).toBe(45);
    expect(result.autoRestrictUnpaid).toBe(true);
  });

  it('falls back to both EntitlementDefault fields when no PlanSetting row exists for the plan at all', async () => {
    const plan = await createPlan('no-setting-plan');

    const result = await service.getEntitlementSet(plan.id);

    expect(result.trialWindowDays).toBe(14);
    expect(result.autoRestrictUnpaid).toBe(true);
  });

  it('maps a null limitValue on PlanFeatureEntitlement to a null EntitlementSet feature limitValue', async () => {
    const plan = await createPlan('null-limit-plan');
    const feature = await createFeature('module.null-limit-test');
    await controlDataSource
      .getRepository(PlanFeatureEntitlement)
      .save({ planId: plan.id, featureKey: feature.key, enabled: true, limitValue: null });

    const result = await service.getEntitlementSet(plan.id);

    expect(result.features).toEqual([{ key: feature.key, enabled: true, limitValue: null }]);
  });

  it('exposes FeatureFlag rows platform-wide via getEntitlementSet, independent of the plan (T099)', async () => {
    const plan = await createPlan('flag-exposure-plan');
    await createFeature('module.checklist-flag-test');
    await controlDataSource.getRepository(FeatureFlag).save({
      featureKey: 'module.checklist-flag-test',
      enabled: false,
      notes: 'gated until Polish sweep',
    });

    const result = await service.getEntitlementSet(plan.id);

    // This test's own flag must be exposed; the platform-shipped `module.accounts`/
    // `module.company_setup` gates (migration-seeded, disabled) may also legitimately
    // appear platform-wide.
    expect(result.featureFlags).toEqual(
      expect.arrayContaining([{ key: 'module.checklist-flag-test', enabled: false }]),
    );
    expect(
      result.featureFlags.every((flag) =>
        ['module.checklist-flag-test', 'module.accounts', 'module.company_setup'].includes(
          flag.key,
        ),
      ),
    ).toBe(true);
  });

  it('isFeatureFlagEnabled reflects a real FeatureFlag row and defaults true when none exists', async () => {
    await createFeature('module.gated-flag-test');
    await controlDataSource
      .getRepository(FeatureFlag)
      .save({ featureKey: 'module.gated-flag-test', enabled: false, notes: null });
    await createFeature('module.ungated-flag-test');

    await expect(service.isFeatureFlagEnabled('module.gated-flag-test')).resolves.toBe(false);
    await expect(service.isFeatureFlagEnabled('module.ungated-flag-test')).resolves.toBe(true);
  });

  it('getEntitlementSetForAccount resolves the plan via the account linked to the JWT sub, not a client-supplied planId', async () => {
    const planA = await createPlan('account-plan-a');
    const planB = await createPlan('account-plan-b');
    const kcUserA = '3d9f6287-47a4-4f50-9d3d-648dcdb74bc7';
    const kcUserB = 'a6ee7c62-a283-42d0-8f71-52dcde0c1e46';
    const accountRepo = controlDataSource.getRepository(Account);
    await accountRepo.save(
      accountRepo.create({
        keycloakUserId: kcUserA,
        email: 'user-a@example.com',
        emailVerified: true,
        mfaEnrolled: true,
        selectedPlanId: planA.id,
      }),
    );
    await accountRepo.save(
      accountRepo.create({
        keycloakUserId: kcUserB,
        email: 'user-b@example.com',
        emailVerified: true,
        mfaEnrolled: true,
        selectedPlanId: planB.id,
      }),
    );

    const resultA = await service.getEntitlementSetForAccount(kcUserA);
    const resultB = await service.getEntitlementSetForAccount(kcUserB);

    expect(resultA.planId).toBe(planA.id);
    expect(resultB.planId).toBe(planB.id);
  });

  it('getEntitlementSetForAccount rejects an unrecognized keycloakUserId', async () => {
    await expect(
      service.getEntitlementSetForAccount('b368d6d8-e292-4347-aef1-0b77d489dbe0'),
    ).rejects.toThrow();
  });

  it('getEntitlementSetForAccount rejects a malformed (non-UUID) keycloakUserId rather than throwing a raw DB error', async () => {
    await expect(service.getEntitlementSetForAccount('not-a-uuid')).rejects.toThrow();
  });

  it('getEntitlementSetForAccount rejects an account that has not selected a plan yet', async () => {
    const kcUserNoPlan = 'c1a2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a5b';
    const accountRepo = controlDataSource.getRepository(Account);
    await accountRepo.save(
      accountRepo.create({
        keycloakUserId: kcUserNoPlan,
        email: 'no-plan@example.com',
        emailVerified: true,
        mfaEnrolled: false,
        selectedPlanId: null,
      }),
    );

    await expect(service.getEntitlementSetForAccount(kcUserNoPlan)).rejects.toThrow();
  });
});
