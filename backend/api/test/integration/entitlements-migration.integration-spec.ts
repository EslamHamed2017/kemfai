import controlDataSource from '../../src/database/data-source';
import { EntitlementDefault } from '../../src/modules/entitlements/entities/entitlement-default.entity';
import { Feature, FeatureKind } from '../../src/modules/entitlements/entities/feature.entity';
import { PlanFeatureEntitlement } from '../../src/modules/entitlements/entities/plan-feature-entitlement.entity';
import { PlanSetting } from '../../src/modules/entitlements/entities/plan-setting.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';

/**
 * T009 acceptance test. Requires a reachable Postgres configured via CONTROL_DB_* env vars, same
 * convention as T006/T007/T008's migration integration specs.
 *
 * `entitlement_default`'s seeded singleton row is never deleted by this suite (only Plan/Feature/
 * PlanFeatureEntitlement/PlanSetting rows created by individual tests are cleaned up) so the suite
 * is repeatable against an already-migrated database, and so the "seeded by the migration itself"
 * assertion below is proving something real rather than something the test just inserted.
 */
describe('Entitlement engine migration + entities (T009)', () => {
  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();
  });

  afterEach(async () => {
    await controlDataSource.query('DELETE FROM "plan_feature_entitlement"');
    await controlDataSource.query('DELETE FROM "plan_setting"');
    await controlDataSource.query('DELETE FROM "feature"');
    await controlDataSource.query('DELETE FROM "plan"');
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  async function createPlan(name: string) {
    const planRepo = controlDataSource.getRepository(Plan);
    return planRepo.save(
      planRepo.create({
        name,
        published: true,
        monthlyPrice: '49.00',
        annualPrice: '490.00',
        currency: 'USD',
      }),
    );
  }

  async function createFeature(key: string) {
    const featureRepo = controlDataSource.getRepository(Feature);
    return featureRepo.save(
      featureRepo.create({ key, displayName: key, kind: FeatureKind.MODULE }),
    );
  }

  it('the migration itself seeds the EntitlementDefault singleton (no separate seed step required)', async () => {
    const repo = controlDataSource.getRepository(EntitlementDefault);

    const rows = await repo.find();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].defaultTrialWindowDays).toBe(14);
    expect(rows[0].defaultAutoRestrictUnpaid).toBe(true);
  });

  it('enforces EntitlementDefault as a DB-level singleton (CHECK id = 1 rejects a second row)', async () => {
    await expect(
      controlDataSource.query(
        'INSERT INTO "entitlement_default" (id, default_trial_window_days, default_auto_restrict_unpaid) VALUES (2, 7, false)',
      ),
    ).rejects.toThrow();
  });

  it('enforces the composite primary key (plan_id, feature_key) on PlanFeatureEntitlement', async () => {
    const plan = await createPlan('composite-pk-plan');
    const feature = await createFeature('module.composite-pk-test');
    const repo = controlDataSource.getRepository(PlanFeatureEntitlement);

    await repo.insert({ planId: plan.id, featureKey: feature.key, enabled: true });

    // `.insert()` (not `.save()`) forces a real INSERT rather than TypeORM's save-as-upsert
    // behavior for entities with an application-supplied composite primary key, so this actually
    // exercises the DB-level primary key constraint rather than silently becoming an UPDATE.
    await expect(
      repo.insert({ planId: plan.id, featureKey: feature.key, enabled: false }),
    ).rejects.toThrow();
  });

  it('rejects a PlanFeatureEntitlement referencing a nonexistent feature_key', async () => {
    const plan = await createPlan('dangling-fk-plan');
    const repo = controlDataSource.getRepository(PlanFeatureEntitlement);

    await expect(
      repo.save(
        repo.create({ planId: plan.id, featureKey: 'module.does-not-exist', enabled: true }),
      ),
    ).rejects.toThrow();
  });

  it('leaves PlanSetting.trial_window_days and auto_restrict_unpaid null with no in-column default', async () => {
    const plan = await createPlan('null-settings-plan');
    const repo = controlDataSource.getRepository(PlanSetting);

    const saved = await repo.save(repo.create({ planId: plan.id }));

    expect(saved.trialWindowDays).toBeNull();
    expect(saved.autoRestrictUnpaid).toBeNull();

    const columns = await controlDataSource.query(
      `SELECT column_name, column_default FROM information_schema.columns
       WHERE table_name = 'plan_setting' AND column_name IN ('trial_window_days', 'auto_restrict_unpaid')`,
    );
    for (const column of columns) {
      expect(column.column_default).toBeNull();
    }
  });

  it('allows PlanSetting to explicitly override both fields per plan (FR-030a)', async () => {
    const plan = await createPlan('override-settings-plan');
    const repo = controlDataSource.getRepository(PlanSetting);

    const saved = await repo.save(
      repo.create({ planId: plan.id, trialWindowDays: 30, autoRestrictUnpaid: false }),
    );

    expect(saved.trialWindowDays).toBe(30);
    expect(saved.autoRestrictUnpaid).toBe(false);
  });

  it('enforces uniqueness on Feature.key', async () => {
    await createFeature('module.unique-key-test');
    const repo = controlDataSource.getRepository(Feature);

    await expect(
      repo.save(
        repo.create({ key: 'module.unique-key-test', displayName: 'dup', kind: FeatureKind.LIMIT }),
      ),
    ).rejects.toThrow();
  });

  it("matches data-model.md's tables: persists every documented field verbatim", async () => {
    const plan = await createPlan('full-fields-plan');
    const feature = await createFeature('module.full-fields-test');
    const entitlementRepo = controlDataSource.getRepository(PlanFeatureEntitlement);
    const settingRepo = controlDataSource.getRepository(PlanSetting);

    const savedEntitlement = await entitlementRepo.save(
      entitlementRepo.create({
        planId: plan.id,
        featureKey: feature.key,
        enabled: true,
        limitValue: '100',
      }),
    );
    const savedSetting = await settingRepo.save(
      settingRepo.create({ planId: plan.id, trialWindowDays: 21, autoRestrictUnpaid: true }),
    );

    expect(plan.name).toBe('full-fields-plan');
    expect(plan.published).toBe(true);
    expect(plan.monthlyPrice).toBe('49.00');
    expect(plan.annualPrice).toBe('490.00');
    expect(plan.currency).toBe('USD');
    expect(feature.kind).toBe(FeatureKind.MODULE);
    expect(savedEntitlement.enabled).toBe(true);
    expect(savedEntitlement.limitValue).toBe('100');
    expect(savedSetting.trialWindowDays).toBe(21);
    expect(savedSetting.autoRestrictUnpaid).toBe(true);
  });
});
