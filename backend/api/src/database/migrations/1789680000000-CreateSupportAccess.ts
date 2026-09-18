import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T013: creates `support_access_grant` and `support_access_usage` in kemfai_control —
 * customer-authorized, time-bounded internal access (data-model.md "SupportAccessGrant /
 * SupportAccessUsage", FR-039–FR-041).
 *
 * `expires_at` is `NOT NULL` on `support_access_grant` — mandatory expiry is enforced at the
 * database level, not left to application discipline (FR-039). `support_access_usage` has no
 * `used_by` FK because internal staff identities live in the `kemfai-internal` Keycloak realm
 * (T016), not in a local table — mirroring `account.keycloak_user_id`'s convention of storing a
 * Keycloak identifier as a bare uuid.
 */
export class CreateSupportAccess1789680000000 implements MigrationInterface {
  name = 'CreateSupportAccess1789680000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "support_access_grantee_role_enum" AS ENUM
        ('BillingAdmin', 'Support', 'SuperAdmin', 'CustomerSuccess', 'TechnicalAdmin')
    `);

    await queryRunner.query(`
      CREATE TABLE "support_access_grant" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "granted_by" uuid NOT NULL,
        "grantee_role" "support_access_grantee_role_enum" NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "revoked_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_support_access_grant_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_support_access_grant_granted_by" FOREIGN KEY ("granted_by")
          REFERENCES "account" ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "support_access_usage" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "grant_id" uuid NOT NULL,
        "used_by" uuid NOT NULL,
        "used_at" timestamptz NOT NULL DEFAULT now(),
        "action_summary" text NOT NULL,
        "was_denied" boolean NOT NULL DEFAULT false,
        "denial_reason" text NULL,
        CONSTRAINT "fk_support_access_usage_grant" FOREIGN KEY ("grant_id")
          REFERENCES "support_access_grant" ("id") ON DELETE RESTRICT
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "support_access_usage"');
    await queryRunner.query('DROP TABLE "support_access_grant"');
    await queryRunner.query('DROP TYPE "support_access_grantee_role_enum"');
  }
}
