import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T032: arms the `module.accounts` feature flag (Constitution Principle VI — "incomplete
 * modules MUST sit behind feature flags"). The Feature row plus a FeatureFlag row with
 * `enabled=false` are seeded IN THE MIGRATION so every environment — production included —
 * ships with the accounts surface hidden by default; exposing it is a pure data act
 * (`UPDATE feature_flag SET enabled = true WHERE feature_key = 'module.accounts'`, no
 * deploy), matching data-model.md's "safe default is hidden / exposed only once explicitly
 * turned on". The dev/quickstart seed (T015) flips it on for local development.
 */
export class SeedAccountsFeatureFlag1789770000000 implements MigrationInterface {
  name = 'SeedAccountsFeatureFlag1789770000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "feature" ("id", "key", "display_name", "kind")
       VALUES (gen_random_uuid(), 'module.accounts', 'Accounts & signup (US1)', 'module')
       ON CONFLICT ("key") DO NOTHING`,
    );
    await queryRunner.query(
      `INSERT INTO "feature_flag" ("feature_key", "enabled", "notes")
       VALUES (
         'module.accounts',
         false,
         'US1 onboarding shell — stays hidden until the story is complete (Constitution Principle VI). Turn on by updating this row, never by a code deploy.'
       )
       ON CONFLICT ("feature_key") DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "feature_flag" WHERE "feature_key" = 'module.accounts'`);
    await queryRunner.query(`DELETE FROM "feature" WHERE "key" = 'module.accounts'`);
  }
}
