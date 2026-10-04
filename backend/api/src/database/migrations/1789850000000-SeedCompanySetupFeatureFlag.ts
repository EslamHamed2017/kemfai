import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T042 (arbiter resolution, 2026-10-04): arms the `module.company_setup` feature flag
 * (Constitution Principle VI) ahead of the real `GET /companies/current/setup` route this
 * task registers. Seeded `enabled=false` in the migration itself, like `module.accounts`
 * (1789770000000-SeedAccountsFeatureFlag.ts), so every environment — production included —
 * ships with the still-incomplete company-setup wizard hidden by default. T054/T055 (or
 * release configuration, once that slice passes acceptance) may flip it on later with a
 * pure data change, never a code deploy.
 */
export class SeedCompanySetupFeatureFlag1789850000000 implements MigrationInterface {
  name = 'SeedCompanySetupFeatureFlag1789850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "feature" ("id", "key", "display_name", "kind")
       VALUES (gen_random_uuid(), 'module.company_setup', 'Company setup wizard (US3)', 'module')
       ON CONFLICT ("key") DO NOTHING`,
    );
    await queryRunner.query(
      `INSERT INTO "feature_flag" ("feature_key", "enabled", "notes")
       VALUES (
         'module.company_setup',
         false,
         'US3 company setup wizard — stays hidden until T054/T055 land step-save/resume/validation (Constitution Principle VI). Turn on by updating this row, never by a code deploy.'
       )
       ON CONFLICT ("feature_key") DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "feature_flag" WHERE "feature_key" = 'module.company_setup'`,
    );
    await queryRunner.query(`DELETE FROM "feature" WHERE "key" = 'module.company_setup'`);
  }
}
