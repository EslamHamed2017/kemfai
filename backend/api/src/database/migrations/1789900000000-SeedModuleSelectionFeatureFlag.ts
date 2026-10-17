import { MigrationInterface, QueryRunner } from 'typeorm';

/** T076: config-driven release gate for the US4 module-selection surface. */
export class SeedModuleSelectionFeatureFlag1789900000000 implements MigrationInterface {
  name = 'SeedModuleSelectionFeatureFlag1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "feature" ("id", "key", "display_name", "kind")
       VALUES (gen_random_uuid(), 'module.module_selection', 'Module selection (US4)', 'module')
       ON CONFLICT ("key") DO NOTHING`,
    );
    await queryRunner.query(
      `INSERT INTO "feature_flag" ("feature_key", "enabled", "notes")
       VALUES (
         'module.module_selection',
         false,
         'US4 module selection release gate. Enable by configuration only after T072/T073/T075/T076 acceptance.'
       )
       ON CONFLICT ("feature_key") DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "feature_flag" WHERE "feature_key" = 'module.module_selection'`,
    );
    await queryRunner.query(`DELETE FROM "feature" WHERE "key" = 'module.module_selection'`);
  }
}
