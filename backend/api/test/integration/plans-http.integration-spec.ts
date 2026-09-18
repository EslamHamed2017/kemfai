import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { Feature, FeatureKind } from '../../src/modules/entitlements/entities/feature.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { PlanFeatureEntitlement } from '../../src/modules/entitlements/entities/plan-feature-entitlement.entity';
import { PlanSummary } from '../../src/modules/plans/plans.service';

/**
 * T031 acceptance test for the real HTTP contract: `GET /public/plans`, end to end (real
 * Nest app, real Postgres). Requires a reachable, already-migrated Postgres configured via
 * CONTROL_DB_* env vars, same convention as the other *-http integration specs.
 *
 * Cleanup only ever targets the exact rows this suite created (tracked by id/key below) —
 * never an unscoped `DELETE FROM`. The control DB is shared with every other integration
 * suite running alongside this one, so a blanket delete would erase unrelated fixture/seed
 * data and make the whole integration run order-dependent (prior review finding). Every
 * plan/feature this suite creates uses a randomUUID-derived name/key so it can never collide
 * with another suite's fixtures (e.g. the dev-quickstart seed's `module.accounting`).
 */
describe('GET /public/plans (T031, HTTP)', () => {
  let app: INestApplication;
  const createdPlanIds: string[] = [];
  const createdFeatureKeys: string[] = [];

  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    // Plan's FK from PlanFeatureEntitlement/PlanSetting is ON DELETE CASCADE (see
    // plan-feature-entitlement.entity.ts / plan-setting.entity.ts), so deleting only the
    // plan rows this test created is sufficient to remove their entitlement/setting rows too.
    if (createdPlanIds.length > 0) {
      await controlDataSource.query('DELETE FROM "plan" WHERE "id" = ANY($1)', [
        createdPlanIds.splice(0, createdPlanIds.length),
      ]);
    }
    if (createdFeatureKeys.length > 0) {
      await controlDataSource.query('DELETE FROM "feature" WHERE "key" = ANY($1)', [
        createdFeatureKeys.splice(0, createdFeatureKeys.length),
      ]);
    }
  });

  afterAll(async () => {
    await app.close();
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  async function createFeature(kind: FeatureKind = FeatureKind.MODULE): Promise<Feature> {
    const featureRepo = controlDataSource.getRepository(Feature);
    const key = `test.plans-http.${randomUUID()}`;
    const feature = await featureRepo.save(featureRepo.create({ key, displayName: key, kind }));
    createdFeatureKeys.push(key);
    return feature;
  }

  async function createPlan(overrides: Partial<Plan> = {}): Promise<Plan> {
    const planRepo = controlDataSource.getRepository(Plan);
    const plan = await planRepo.save(
      planRepo.create({
        name: `plan-${randomUUID()}`,
        published: true,
        monthlyPrice: '10.00',
        annualPrice: '100.00',
        currency: 'USD',
        ...overrides,
      }),
    );
    createdPlanIds.push(plan.id);
    return plan;
  }

  async function createEntitlement(
    planId: string,
    featureKey: string,
    enabled: boolean,
  ): Promise<void> {
    const entitlementRepo = controlDataSource.getRepository(PlanFeatureEntitlement);
    await entitlementRepo.save(
      entitlementRepo.create({ planId, featureKey, enabled, limitValue: null }),
    );
  }

  it('is reachable with no Authorization header (@Public bypasses the global BearerAuthGuard)', async () => {
    const response = await request(app.getHttpServer()).get('/public/plans').expect(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  it('never includes an unpublished plan', async () => {
    const feature = await createFeature();
    const unpublished = await createPlan({ published: false });
    await createEntitlement(unpublished.id, feature.key, true);

    const response = await request(app.getHttpServer()).get('/public/plans').expect(200);

    const ids = (response.body as PlanSummary[]).map((summary) => summary.id);
    expect(ids).not.toContain(unpublished.id);
  });

  it('returns a published plan matching the PlanSummary schema, with only its enabled features', async () => {
    const enabledFeature = await createFeature();
    const disabledFeature = await createFeature();
    const plan = await createPlan({
      name: 'Growth (T031 test)',
      monthlyPrice: '1200.00',
      annualPrice: '12000.00',
      currency: 'EGP',
    });
    await createEntitlement(plan.id, enabledFeature.key, true);
    await createEntitlement(plan.id, disabledFeature.key, false);

    const response = await request(app.getHttpServer()).get('/public/plans').expect(200);

    const summary = (response.body as PlanSummary[]).find((item) => item.id === plan.id);
    expect(summary).toEqual({
      id: plan.id,
      name: 'Growth (T031 test)',
      monthlyPrice: 1200,
      annualPrice: 12000,
      currency: 'EGP',
      features: [enabledFeature.key],
    });
  });
});
