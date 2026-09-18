import { DataSource } from 'typeorm';
import controlDataSource from '../data-source';
import { EntitlementDefault } from '../../modules/entitlements/entities/entitlement-default.entity';
import { Feature, FeatureKind } from '../../modules/entitlements/entities/feature.entity';
import { Plan } from '../../modules/entitlements/entities/plan.entity';
import { PlanFeatureEntitlement } from '../../modules/entitlements/entities/plan-feature-entitlement.entity';
import { PlanSetting } from '../../modules/entitlements/entities/plan-setting.entity';

/**
 * T015: dev/quickstart seed for kemfai_control (FR-016, FR-030, FR-030a).
 *
 * Everything below is seed/test data, which is the one place plan names and values are
 * allowed to appear (Constitution P-07 / T009 acceptance criteria) — no runtime code may
 * branch on them. The seed is idempotent: every statement is an upsert keyed on natural
 * keys, so re-running it against an already-seeded database changes nothing.
 *
 * `EntitlementDefault` is normally created by the CreateEntitlements migration itself; the
 * seed restores it if missing (`ON CONFLICT DO NOTHING` — never clobbers tuned values) so
 * the script is self-sufficient on a freshly migrated database. `PlanSetting` is inserted
 * with BOTH FR-030a fields NULL per T015's acceptance criteria, deliberately exercising the
 * `EntitlementDefault` fallback path end-to-end; re-runs never overwrite the row, so a dev
 * who overrides `trial_window_days`/`auto_restrict_unpaid` manually keeps their override.
 */

/** Deterministic id so repeated runs upsert the same dev plan instead of publishing a second one. */
export const SEED_PLAN_ID = '00000000-0000-4000-8000-000000000015';

/** Same values the CreateEntitlements migration seeds (single source: FR-030a defaults). */
const SEED_ENTITLEMENT_DEFAULT = {
  id: 1,
  defaultTrialWindowDays: 14,
  defaultAutoRestrictUnpaid: true,
};

const SEED_FEATURES = [
  { key: 'module.accounting', displayName: 'Accounting', kind: FeatureKind.MODULE },
  { key: 'module.invoicing', displayName: 'Invoicing', kind: FeatureKind.MODULE },
  {
    key: 'limit.users',
    displayName: 'User seats',
    kind: FeatureKind.LIMIT,
  },
] satisfies Array<{ key: string; displayName: string; kind: FeatureKind }>;

const SEED_PLAN = {
  id: SEED_PLAN_ID,
  name: 'Growth (dev seed)',
  published: true,
  monthlyPrice: '1200.00',
  annualPrice: '12000.00',
  currency: 'EGP',
} satisfies Omit<Plan, 'createdAt' | 'updatedAt'>;

const SEED_ENTITLEMENTS = [
  { featureKey: 'module.accounting', enabled: true, limitValue: null },
  { featureKey: 'module.invoicing', enabled: true, limitValue: null },
  { featureKey: 'limit.users', enabled: true, limitValue: '5.00' },
] satisfies Array<{ featureKey: string; enabled: boolean; limitValue: string | null }>;

export async function runDevQuickstartSeed(dataSource: DataSource): Promise<void> {
  // 1. EntitlementDefault singleton — restore-if-missing only.
  await dataSource
    .createQueryBuilder()
    .insert()
    .into(EntitlementDefault)
    .values(SEED_ENTITLEMENT_DEFAULT)
    .onConflict('("id") DO NOTHING')
    .execute();

  // 2. Features — keyed on the stable `key` (the identifier entitlements/flags join on).
  await dataSource
    .createQueryBuilder()
    .insert()
    .into(Feature)
    .values(SEED_FEATURES)
    .onConflict(
      '("key") DO UPDATE SET "display_name" = EXCLUDED."display_name", "kind" = EXCLUDED."kind"',
    )
    .execute();

  // 3. One published Plan — keyed on the deterministic SEED_PLAN_ID.
  await dataSource
    .createQueryBuilder()
    .insert()
    .into(Plan)
    .values(SEED_PLAN)
    .onConflict(
      '("id") DO UPDATE SET "name" = EXCLUDED."name", "published" = EXCLUDED."published", ' +
        '"monthly_price" = EXCLUDED."monthly_price", "annual_price" = EXCLUDED."annual_price", ' +
        '"currency" = EXCLUDED."currency"',
    )
    .execute();

  // 4. PlanFeatureEntitlement — composite (plan_id, feature_key) upsert.
  await dataSource
    .createQueryBuilder()
    .insert()
    .into(PlanFeatureEntitlement)
    .values(SEED_ENTITLEMENTS.map((entitlement) => ({ ...entitlement, planId: SEED_PLAN_ID })))
    .onConflict(
      '("plan_id", "feature_key") DO UPDATE SET "enabled" = EXCLUDED."enabled", ' +
        '"limit_value" = EXCLUDED."limit_value"',
    )
    .execute();

  // 5. PlanSetting with both FR-030a fields NULL ("use EntitlementDefault") — insert-only,
  //    so manual per-plan overrides survive re-runs.
  await dataSource
    .createQueryBuilder()
    .insert()
    .into(PlanSetting)
    .values({ planId: SEED_PLAN_ID, trialWindowDays: null, autoRestrictUnpaid: null })
    .onConflict('("plan_id") DO NOTHING')
    .execute();
}

if (require.main === module) {
  (async () => {
    const dataSource = controlDataSource.isInitialized
      ? controlDataSource
      : await controlDataSource.initialize();
    try {
      await runDevQuickstartSeed(dataSource);
      console.log(
        `[seed:dev] kemfai_control seeded: EntitlementDefault singleton, published plan ` +
          `${SEED_PLAN_ID} (${SEED_PLAN.name}), ${SEED_FEATURES.length} features, ` +
          `${SEED_ENTITLEMENTS.length} entitlements, PlanSetting(trial_window_days=null, ` +
          `auto_restrict_unpaid=null)`,
      );
    } finally {
      if (dataSource === controlDataSource) {
        await controlDataSource.destroy();
      }
    }
  })().catch((error) => {
    console.error('[seed:dev] failed:', error);
    process.exitCode = 1;
  });
}
