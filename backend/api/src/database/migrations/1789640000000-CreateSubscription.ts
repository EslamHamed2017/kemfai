import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T011: creates the `subscription` table in kemfai_control — the billing relationship for a
 * tenant (data-model.md "Subscription"). The unique constraint on `tenant_id` enforces "a tenant
 * has exactly one Subscription row, full stop" (F8 remediation, analysis.md) — renewal for a new
 * period updates `current_period_start/end` on this same row rather than inserting a new one.
 */
export class CreateSubscription1789640000000 implements MigrationInterface {
  name = 'CreateSubscription1789640000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "subscription_billing_cycle_enum" AS ENUM ('monthly', 'annual')
    `);
    await queryRunner.query(`
      CREATE TYPE "subscription_status_enum" AS ENUM
        ('PendingActivation', 'Active', 'Suspended', 'Cancelled')
    `);
    await queryRunner.query(`
      CREATE TABLE "subscription" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "plan_id" uuid NOT NULL,
        "billing_cycle" "subscription_billing_cycle_enum" NOT NULL,
        "status" "subscription_status_enum" NOT NULL DEFAULT 'PendingActivation',
        "current_period_start" date NOT NULL,
        "current_period_end" date NOT NULL,
        "activated_at" timestamptz NULL,
        "activated_by" uuid NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_subscription_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_subscription_plan" FOREIGN KEY ("plan_id")
          REFERENCES "plan" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_subscription_activated_by" FOREIGN KEY ("activated_by")
          REFERENCES "account" ("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_subscription_tenant_id" ON "subscription" ("tenant_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "subscription"');
    await queryRunner.query('DROP TYPE "subscription_status_enum"');
    await queryRunner.query('DROP TYPE "subscription_billing_cycle_enum"');
  }
}
