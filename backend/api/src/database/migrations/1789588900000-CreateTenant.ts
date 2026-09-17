import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T008: creates the `tenant` table in kemfai_control — the tenant/workspace registry entry
 * (data-model.md "Tenant"). The unique + FK constraint on `account_id` enforces the 1:1
 * Account-to-Tenant relationship and makes provisioning idempotent at the database level
 * (FR-023), independent of any application-level "create if not exists" logic.
 */
export class CreateTenant1789588900000 implements MigrationInterface {
  name = 'CreateTenant1789588900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "tenant_status_enum" AS ENUM ('Pending', 'Creating', 'Ready', 'Failed')
    `);
    await queryRunner.query(`
      CREATE TABLE "tenant" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "account_id" uuid NOT NULL,
        "status" "tenant_status_enum" NOT NULL DEFAULT 'Pending',
        "odoo_db_name" text NULL,
        "minio_bucket" text NULL,
        "provisioning_attempts" integer NOT NULL DEFAULT 0,
        "failure_reason" text NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "ready_at" timestamptz NULL,
        CONSTRAINT "fk_tenant_account" FOREIGN KEY ("account_id")
          REFERENCES "account" ("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_tenant_account_id" ON "tenant" ("account_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "tenant"');
    await queryRunner.query('DROP TYPE "tenant_status_enum"');
  }
}
