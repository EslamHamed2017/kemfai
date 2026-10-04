import controlDataSource from '../../src/database/data-source';
import { FeatureFlag } from '../../src/modules/entitlements/entities/feature-flag.entity';
import { Feature, FeatureKind } from '../../src/modules/entitlements/entities/feature.entity';

/**
 * T099 acceptance test. Requires a reachable Postgres configured via CONTROL_DB_* env vars, same
 * convention as T009's entitlements-migration.integration-spec.ts.
 */
describe('FeatureFlag migration + entity (T099)', () => {
  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();
  });

  afterEach(async () => {
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
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  async function createFeature(key: string) {
    const featureRepo = controlDataSource.getRepository(Feature);
    return featureRepo.save(
      featureRepo.create({ key, displayName: key, kind: FeatureKind.MODULE }),
    );
  }

  it('defaults enabled=false when not specified (safe default is hidden)', async () => {
    const feature = await createFeature('module.default-flag-test');
    const repo = controlDataSource.getRepository(FeatureFlag);

    const saved = await repo.save(repo.create({ featureKey: feature.key }));

    expect(saved.enabled).toBe(false);
    expect(saved.notes).toBeNull();
  });

  it('rejects a FeatureFlag referencing a nonexistent feature_key', async () => {
    const repo = controlDataSource.getRepository(FeatureFlag);

    await expect(
      repo.save(repo.create({ featureKey: 'module.does-not-exist', enabled: true })),
    ).rejects.toThrow();
  });

  it('enforces feature_key as the primary key (a second row for the same key fails)', async () => {
    const feature = await createFeature('module.pk-flag-test');
    const repo = controlDataSource.getRepository(FeatureFlag);
    await repo.insert({ featureKey: feature.key, enabled: true });

    await expect(repo.insert({ featureKey: feature.key, enabled: false })).rejects.toThrow();
  });

  it('cascades delete when the referenced Feature is deleted', async () => {
    const feature = await createFeature('module.cascade-flag-test');
    const repo = controlDataSource.getRepository(FeatureFlag);
    await repo.save(repo.create({ featureKey: feature.key, enabled: true }));

    await controlDataSource.getRepository(Feature).delete({ key: feature.key });

    const remaining = await repo.find({ where: { featureKey: feature.key } });
    expect(remaining).toHaveLength(0);
  });

  it('persists notes as free text and allows it to remain null', async () => {
    const feature = await createFeature('module.notes-flag-test');
    const repo = controlDataSource.getRepository(FeatureFlag);

    const saved = await repo.save(
      repo.create({
        featureKey: feature.key,
        enabled: true,
        notes: 'US7 checklist — gate until Polish sweep',
      }),
    );

    expect(saved.notes).toBe('US7 checklist — gate until Polish sweep');
  });
});
