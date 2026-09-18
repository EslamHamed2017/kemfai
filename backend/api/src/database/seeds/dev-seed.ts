import 'reflect-metadata';
import { DataSource } from 'typeorm';
import controlDataSource from '../data-source';
import { EntitlementDefault } from '../../modules/entitlements/entities/entitlement-default.entity';
import { Feature, FeatureKind } from '../../modules/entitlements/entities/feature.entity';
import { PlanFeatureEntitlement } from '../../modules/entitlements/entities/plan-feature-entitlement.entity';
import { PlanSetting } from '../../modules/entitlements/entities/plan-setting.entity';
import { Plan } from '../../modules/entitlements/entities/plan.entity';

export const DEV_SEED_PLAN_NAME = 'Starter';
export const DEV_SEED_FEATURE_KEYS = ['module.accounting', 'module.projects'] as const;

/**
 * T015: dev/quickstart seed. Creates exactly one published Plan (with Feature/
 * PlanFeatureEntitlement/PlanSetting rows) so `GET /public/plans` (once T031 exists) has
 * something to return. `PlanSetting.trial_window_days` and `auto_restrict_unpaid` are both left
 * null on purpose — this seed exists specifically to exercise the `EntitlementDefault` fallback
 * path (T009/T010) end-to-end, not to exercise a per-plan override (that's covered by
 * entitlements-migration.integration-spec.ts instead).
 *
 * Idempotent by design (safe to run repeatedly against the same dev DB): re-running when the
 * `DEV_SEED_PLAN_NAME` plan already exists is a no-op rather than creating a second plan, since
 * `Plan.name` carries no uniqueness constraint in the schema.
 */
export async function runDevSeed(dataSource: DataSource): Promise<void> {
  await dataSource.getRepository(EntitlementDefault).findOneByOrFail({ id: 1 });

  const planRepo = dataSource.getRepository(Plan);
  const existing = await planRepo.findOne({ where: { name: DEV_SEED_PLAN_NAME } });
  if (existing) {
    return;
  }

  const plan = await planRepo.save(
    planRepo.create({
      name: DEV_SEED_PLAN_NAME,
      published: true,
      monthlyPrice: '49.00',
      annualPrice: '490.00',
      currency: 'USD',
    }),
  );

  const featureRepo = dataSource.getRepository(Feature);
  const features = await Promise.all(
    DEV_SEED_FEATURE_KEYS.map(async (key) => {
      const found = await featureRepo.findOne({ where: { key } });
      if (found) {
        return found;
      }
      return featureRepo.save(
        featureRepo.create({ key, displayName: key, kind: FeatureKind.MODULE }),
      );
    }),
  );

  const entitlementRepo = dataSource.getRepository(PlanFeatureEntitlement);
  await entitlementRepo.save(
    features.map((feature) =>
      entitlementRepo.create({ planId: plan.id, featureKey: feature.key, enabled: true }),
    ),
  );

  const settingRepo = dataSource.getRepository(PlanSetting);
  await settingRepo.save(
    settingRepo.create({ planId: plan.id, trialWindowDays: null, autoRestrictUnpaid: null }),
  );
}

/* istanbul ignore if -- exercised by running `npm run seed:dev`, not by the test suite */
if (require.main === module) {
  controlDataSource
    .initialize()
    .then((ds) => runDevSeed(ds))
    .then(() => controlDataSource.destroy())
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error);
      process.exitCode = 1;
      return controlDataSource.destroy();
    });
}
