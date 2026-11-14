import { MigrationInterface, QueryRunner } from 'typeorm';

/** Fail-closed release gate for the safe Accounting Foundation surface. */
export class SeedAccountingFoundationFeatureFlag1790001000000 implements MigrationInterface {
  name = 'SeedAccountingFoundationFeatureFlag1790001000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "feature" ("id", "key", "display_name", "kind")
      VALUES (
        gen_random_uuid(),
        'module.accounting_foundation',
        'Accounting Foundation',
        'module'
      )
      ON CONFLICT ("key") DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "feature_flag" ("feature_key", "enabled", "notes")
      VALUES (
        'module.accounting_foundation',
        false,
        'Safe accounting master-data and non-posting draft surface; enable only after acceptance.'
      )
      ON CONFLICT ("feature_key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "feature_flag" WHERE "feature_key" = 'module.accounting_foundation'`,
    );
    await queryRunner.query(`DELETE FROM "feature" WHERE "key" = 'module.accounting_foundation'`);
  }
}
