import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T007: creates the `account` table in kemfai_control — the identity record backing a Keycloak
 * `kemfai-customers` user (data-model.md "Account"). `citext` gives case-insensitive email
 * uniqueness without application-side lower()-ing.
 */
export class CreateAccount1789567327778 implements MigrationInterface {
  name = 'CreateAccount1789567327778';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS citext');
    await queryRunner.query(`
      CREATE TYPE "account_selected_billing_cycle_enum" AS ENUM ('monthly', 'annual')
    `);
    await queryRunner.query(`
      CREATE TYPE "account_preferred_locale_enum" AS ENUM ('en', 'ar')
    `);
    await queryRunner.query(`
      CREATE TABLE "account" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "keycloak_user_id" uuid NOT NULL,
        "email" citext NOT NULL,
        "email_verified" boolean NOT NULL DEFAULT false,
        "mfa_enrolled" boolean NOT NULL DEFAULT false,
        "selected_plan_id" uuid NULL,
        "selected_billing_cycle" "account_selected_billing_cycle_enum" NULL,
        "preferred_locale" "account_preferred_locale_enum" NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_account_email" ON "account" ("email")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "account"');
    await queryRunner.query('DROP TYPE "account_preferred_locale_enum"');
    await queryRunner.query('DROP TYPE "account_selected_billing_cycle_enum"');
  }
}
