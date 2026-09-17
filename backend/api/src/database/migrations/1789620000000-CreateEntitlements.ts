import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T009: creates the entitlement engine tables in kemfai_control (data-model.md "Plan / Feature /
 * PlanFeatureEntitlement / PlanSetting / EntitlementDefault", FR-030/FR-030a). This is the only
 * schema any module-selection, usage-limit, trial-window, or auto-restriction check may ultimately
 * read from (via EntitlementsService, T010) — no plan-name branching anywhere in code (Constitution
 * P-07).
 *
 * `entitlement_default` is a DB-enforced singleton (`CHECK (id = 1)` + primary key) and this
 * migration seeds its one row directly, rather than relying on column DEFAULTs, so the fallback
 * values (`default_trial_window_days=14`, `default_auto_restrict_unpaid=true`) exist immediately
 * after `migration:run` with no separate seed step required for the fallback path itself (distinct
 * from T015's dev/quickstart Plan seed).
 */
export class CreateEntitlements1789620000000 implements MigrationInterface {
  name = 'CreateEntitlements1789620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "feature_kind_enum" AS ENUM ('module', 'limit')
    `);

    await queryRunner.query(`
      CREATE TABLE "plan" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" text NOT NULL,
        "published" boolean NOT NULL DEFAULT false,
        "monthly_price" numeric(12,2) NOT NULL,
        "annual_price" numeric(12,2) NOT NULL,
        "currency" char(3) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "feature" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "key" text NOT NULL,
        "display_name" text NOT NULL,
        "kind" "feature_kind_enum" NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_feature_key" ON "feature" ("key")
    `);

    await queryRunner.query(`
      CREATE TABLE "plan_feature_entitlement" (
        "plan_id" uuid NOT NULL,
        "feature_key" text NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "limit_value" numeric NULL,
        CONSTRAINT "pk_plan_feature_entitlement" PRIMARY KEY ("plan_id", "feature_key"),
        CONSTRAINT "fk_plan_feature_entitlement_plan" FOREIGN KEY ("plan_id")
          REFERENCES "plan" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_plan_feature_entitlement_feature" FOREIGN KEY ("feature_key")
          REFERENCES "feature" ("key") ON DELETE RESTRICT
      )
    `);

    // PlanSetting: trial_window_days / auto_restrict_unpaid are intentionally left without an
    // in-column DEFAULT — NULL means "use EntitlementDefault", so a documented default here would
    // contradict the sentinel (I1 remediation, analysis.md).
    await queryRunner.query(`
      CREATE TABLE "plan_setting" (
        "plan_id" uuid PRIMARY KEY,
        "trial_window_days" integer NULL,
        "auto_restrict_unpaid" boolean NULL,
        CONSTRAINT "fk_plan_setting_plan" FOREIGN KEY ("plan_id")
          REFERENCES "plan" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "entitlement_default" (
        "id" smallint PRIMARY KEY,
        "default_trial_window_days" integer NOT NULL,
        "default_auto_restrict_unpaid" boolean NOT NULL,
        CONSTRAINT "ck_entitlement_default_singleton" CHECK ("id" = 1)
      )
    `);
    await queryRunner.query(`
      INSERT INTO "entitlement_default" ("id", "default_trial_window_days", "default_auto_restrict_unpaid")
      VALUES (1, 14, true)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "entitlement_default"');
    await queryRunner.query('DROP TABLE "plan_setting"');
    await queryRunner.query('DROP TABLE "plan_feature_entitlement"');
    await queryRunner.query('DROP TABLE "feature"');
    await queryRunner.query('DROP TABLE "plan"');
    await queryRunner.query('DROP TYPE "feature_kind_enum"');
  }
}
