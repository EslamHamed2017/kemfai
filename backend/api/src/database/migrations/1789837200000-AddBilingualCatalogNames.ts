import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T036: customer-facing catalog copy is stored in both launch languages.
 *
 * Every operation is conditional because the rejected T036 migration may have been
 * recorded under another class name while leaving one or more columns behind. This
 * migration therefore converges both fresh and partially-upgraded databases safely.
 * Legacy columns remain for pre-launch fixture/admin compatibility.
 */
export class AddBilingualCatalogNames1789837200000 implements MigrationInterface {
  name = 'AddBilingualCatalogNames1789837200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A rejected migration seen in pre-launch databases dropped these original columns.
    // Restore them first because older fixtures/admin paths and the current entities still
    // use them; they are no longer returned by the public API.
    await queryRunner.query('ALTER TABLE "plan" ADD COLUMN IF NOT EXISTS "name" text NULL');
    await queryRunner.query(
      'ALTER TABLE "feature" ADD COLUMN IF NOT EXISTS "display_name" text NULL',
    );
    await queryRunner.query('ALTER TABLE "plan" ADD COLUMN IF NOT EXISTS "name_en" text NULL');
    await queryRunner.query('ALTER TABLE "plan" ADD COLUMN IF NOT EXISTS "name_ar" text NULL');
    await queryRunner.query(
      'ALTER TABLE "feature" ADD COLUMN IF NOT EXISTS "display_name_en" text NULL',
    );
    await queryRunner.query(
      'ALTER TABLE "feature" ADD COLUMN IF NOT EXISTS "display_name_ar" text NULL',
    );
    // The rejected migration made translations NOT NULL and thereby broke every existing
    // fixture/admin write before a translation could be supplied. Keep draft data nullable;
    // publication safety is enforced by PlansService, which returns only complete EN+AR data.
    await queryRunner.query('ALTER TABLE "plan" ALTER COLUMN "name_en" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "plan" ALTER COLUMN "name_ar" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "feature" ALTER COLUMN "display_name_en" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "feature" ALTER COLUMN "display_name_ar" DROP NOT NULL');

    // English can be losslessly backfilled from the former customer-facing fields.
    // Arabic must never be fabricated from English; incomplete plans are unpublished.
    await queryRunner.query(
      'UPDATE "plan" SET "name" = COALESCE(NULLIF(BTRIM("name"), \'\'), NULLIF(BTRIM("name_en"), \'\'), NULLIF(BTRIM("name_ar"), \'\'), \'untranslated plan\')',
    );
    await queryRunner.query(
      'UPDATE "feature" SET "display_name" = COALESCE(NULLIF(BTRIM("display_name"), \'\'), NULLIF(BTRIM("display_name_en"), \'\'), NULLIF(BTRIM("display_name_ar"), \'\'), "key")',
    );
    await queryRunner.query('ALTER TABLE "plan" ALTER COLUMN "name" SET NOT NULL');
    await queryRunner.query('ALTER TABLE "feature" ALTER COLUMN "display_name" SET NOT NULL');
    await queryRunner.query(
      'UPDATE "plan" SET "name_en" = "name" WHERE NULLIF(BTRIM("name_en"), \'\') IS NULL',
    );
    await queryRunner.query(
      'UPDATE "feature" SET "display_name_en" = "display_name" WHERE NULLIF(BTRIM("display_name_en"), \'\') IS NULL',
    );
    await queryRunner.query(
      'UPDATE "plan" SET "published" = false WHERE NULLIF(BTRIM("name_en"), \'\') IS NULL OR NULLIF(BTRIM("name_ar"), \'\') IS NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "feature" DROP COLUMN IF EXISTS "display_name_ar"');
    await queryRunner.query('ALTER TABLE "feature" DROP COLUMN IF EXISTS "display_name_en"');
    await queryRunner.query('ALTER TABLE "plan" DROP COLUMN IF EXISTS "name_ar"');
    await queryRunner.query('ALTER TABLE "plan" DROP COLUMN IF EXISTS "name_en"');
    // Legacy columns intentionally survive down(): they pre-date T036 and may have been
    // repaired by this migration after the rejected migration removed them.
  }
}
