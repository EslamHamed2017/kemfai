import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T099: creates `feature_flag` (data-model.md "FeatureFlag", Constitution Principle VI —
 * "incomplete modules MUST sit behind feature flags"). PK/FK is `feature_key` → `feature.key`, the
 * same join shape as `plan_feature_entitlement` (T009), so module-completeness gating reuses the
 * existing config-driven structure rather than introducing a second mechanism. `enabled` defaults to
 * `false` so a newly added flag is hidden by default until explicitly turned on.
 */
export class CreateFeatureFlag1789740000000 implements MigrationInterface {
  name = 'CreateFeatureFlag1789740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "feature_flag" (
        "feature_key" text PRIMARY KEY,
        "enabled" boolean NOT NULL DEFAULT false,
        "notes" text NULL,
        CONSTRAINT "fk_feature_flag_feature" FOREIGN KEY ("feature_key")
          REFERENCES "feature" ("key") ON DELETE CASCADE
      )
    `);

    // Mirrors every other non-audit control-plane table's runtime grant (CreateAuditEvent's
    // explicit GRANT/REVOKE pair is the only precedent committed to a migration; this one is
    // unrestricted since FeatureFlag carries no immutability requirement).
    await queryRunner.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "feature_flag" TO "kemfai_api"',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "feature_flag"');
  }
}
