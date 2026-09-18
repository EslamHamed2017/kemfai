import controlDataSource from '../../src/database/data-source';
import { SEED_PLAN_ID, runDevQuickstartSeed } from '../../src/database/seeds/dev-quickstart.seed';
import { EntitlementsService } from '../../src/modules/entitlements/entitlements.service';

/**
 * T015 acceptance test. Requires a reachable, already-migrated Postgres configured via
 * CONTROL_DB_* env vars, same convention as the other migration integration specs.
 *
 * Proves, against the real kemfai_control schema: (1) the seed yields exactly one
 * published plan with its Feature/PlanFeatureEntitlement/PlanSetting rows and the
 * EntitlementDefault singleton (the DB-level precondition for `GET /public/plans`
 * returning exactly one published plan once T031 exists); (2) the seeded PlanSetting's
 * null FR-030a fields exercise the EntitlementDefault fallback end-to-end through the
 * real EntitlementsService (T010); (3) the seed is idempotent; (4) it is self-sufficient
 * about the EntitlementDefault singleton.
 */
describe('Dev/quickstart seed (T015)', () => {
  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();
  });

  afterEach(async () => {
    // Only clean tables this suite's fixture (the seed) writes — entitlement_default is
    // deliberately never deleted here (T009 review lesson: the migration-seeded singleton
    // must stay intact for suites that assert it).
    await controlDataSource.query('DELETE FROM "plan_feature_entitlement"');
    await controlDataSource.query('DELETE FROM "plan_setting"');
    await controlDataSource.query('DELETE FROM "plan"');
    await controlDataSource.query('DELETE FROM "feature"');
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  it('seeds exactly one published plan carrying entitlements and a null-FR-030a PlanSetting', async () => {
    await runDevQuickstartSeed(controlDataSource);

    const plans = await controlDataSource.query('SELECT * FROM "plan"');
    expect(plans).toHaveLength(1);
    expect(plans[0].id).toBe(SEED_PLAN_ID);
    expect(plans[0].published).toBe(true);
    expect(plans[0].currency).toHaveLength(3);

    const entitlements = await controlDataSource.query(
      'SELECT * FROM "plan_feature_entitlement" WHERE "plan_id" = $1',
      [SEED_PLAN_ID],
    );
    expect(entitlements).toHaveLength(3);
    expect(entitlements.every((e: { plan_id: string }) => e.plan_id === SEED_PLAN_ID)).toBe(true);

    const settings = await controlDataSource.query(
      'SELECT * FROM "plan_setting" WHERE "plan_id" = $1',
      [SEED_PLAN_ID],
    );
    expect(settings).toHaveLength(1);
    expect(settings[0].trial_window_days).toBeNull();
    expect(settings[0].auto_restrict_unpaid).toBeNull();

    const features = await controlDataSource.query('SELECT * FROM "feature"');
    expect(features).toHaveLength(4);
    for (const feature of features) {
      expect(['module', 'limit']).toContain(feature.kind);
    }

    // T032: the dev seed also flips the accounts module's feature flag ON so the dev
    // quickstart walkthrough is exercisable locally (production keeps the migration's
    // enabled=false default and flips the row by data when US1 is complete).
    const flags = await controlDataSource.query(
      'SELECT * FROM "feature_flag" WHERE "feature_key" = \'module.accounts\'',
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].enabled).toBe(true);
  });

  it('exercises the EntitlementDefault fallback end-to-end via EntitlementsService (both FR-030a fields)', async () => {
    await runDevQuickstartSeed(controlDataSource);

    const entitlementSet = await new EntitlementsService().getEntitlementSet(SEED_PLAN_ID);

    expect(entitlementSet.planId).toBe(SEED_PLAN_ID);
    // Both resolved from EntitlementDefault (14/true), since the seeded PlanSetting is null/null.
    expect(entitlementSet.trialWindowDays).toBe(14);
    expect(entitlementSet.autoRestrictUnpaid).toBe(true);
    expect(entitlementSet.features).toEqual(
      expect.arrayContaining([
        { key: 'module.accounting', enabled: true, limitValue: null },
        { key: 'module.invoicing', enabled: true, limitValue: null },
        { key: 'limit.users', enabled: true, limitValue: 5 },
      ]),
    );
  });

  it('is idempotent — running the seed twice yields the same row counts and still one published plan', async () => {
    await runDevQuickstartSeed(controlDataSource);
    await runDevQuickstartSeed(controlDataSource);

    const counts = await controlDataSource.query(`
      SELECT
        (SELECT count(*) FROM "plan") AS plans,
        (SELECT count(*) FROM "plan" WHERE "published") AS published_plans,
        (SELECT count(*) FROM "plan_setting") AS settings,
        (SELECT count(*) FROM "plan_feature_entitlement") AS entitlements,
        (SELECT count(*) FROM "feature") AS features,
        (SELECT count(*) FROM "entitlement_default") AS defaults,
        (SELECT count(*) FROM "feature_flag") AS flags
    `);
    expect(counts[0]).toEqual({
      plans: '1',
      published_plans: '1',
      settings: '1',
      entitlements: '3',
      features: '4',
      defaults: '1',
      flags: '1',
    });
  });

  it('re-creates the EntitlementDefault singleton when missing (seed is self-sufficient)', async () => {
    await controlDataSource.query('DELETE FROM "entitlement_default"');
    try {
      await runDevQuickstartSeed(controlDataSource);
      const defaults = await controlDataSource.query('SELECT * FROM "entitlement_default"');
      expect(defaults).toHaveLength(1);
      expect(defaults[0].id).toBe(1);
      expect(defaults[0].default_trial_window_days).toBe(14);
      expect(defaults[0].default_auto_restrict_unpaid).toBe(true);
    } finally {
      // Leave the singleton in place no matter how the assertion above fares, so suites
      // that assert the migration-seeded row are unaffected by this test.
      await controlDataSource.query(
        'INSERT INTO "entitlement_default" ("id", "default_trial_window_days", "default_auto_restrict_unpaid") ' +
          'VALUES (1, 14, true) ON CONFLICT ("id") DO NOTHING',
      );
    }
  });
});
