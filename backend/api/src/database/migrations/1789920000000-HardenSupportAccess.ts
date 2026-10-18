import { MigrationInterface, QueryRunner } from 'typeorm';

/** T084–T091: append-only hardening for explicit capabilities and atomic expiry state. */
export class HardenSupportAccess1789920000000 implements MigrationInterface {
  name = 'HardenSupportAccess1789920000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "support_access_grant_status_enum" AS ENUM ('Active', 'Expired', 'Revoked')`,
    );
    await queryRunner.query(`ALTER TABLE "support_access_grant"
      ADD COLUMN "permitted_actions" text[] NOT NULL DEFAULT ARRAY['workspace.summary.read']::text[],
      ADD COLUMN "expired_at" timestamptz NULL,
      ADD COLUMN "status" "support_access_grant_status_enum" NOT NULL DEFAULT 'Active'`);
    await queryRunner.query(`CREATE INDEX "idx_support_access_grant_expiry_active"
      ON "support_access_grant" ("expires_at") WHERE "status" = 'Active'`);
    await queryRunner.query(`CREATE INDEX "idx_support_access_grant_tenant_role"
      ON "support_access_grant" ("tenant_id", "grantee_role", "created_at" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_support_access_usage_grant_used"
      ON "support_access_usage" ("grant_id", "used_at" DESC)`);
    await queryRunner.query(`INSERT INTO "feature" ("id","key","display_name","kind")
      VALUES (gen_random_uuid(),'module.support_access','Temporary support access (US8)','module')
      ON CONFLICT ("key") DO NOTHING`);
    await queryRunner.query(`INSERT INTO "feature_flag" ("feature_key","enabled","notes")
      VALUES ('module.support_access',false,'US8 release gate; enable only after acceptance.')
      ON CONFLICT ("feature_key") DO NOTHING`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "feature_flag" WHERE "feature_key"='module.support_access'`,
    );
    await queryRunner.query(`DELETE FROM "feature" WHERE "key"='module.support_access'`);
    await queryRunner.query('DROP INDEX "idx_support_access_usage_grant_used"');
    await queryRunner.query('DROP INDEX "idx_support_access_grant_tenant_role"');
    await queryRunner.query('DROP INDEX "idx_support_access_grant_expiry_active"');
    await queryRunner.query(
      `ALTER TABLE "support_access_grant" DROP COLUMN "status", DROP COLUMN "expired_at", DROP COLUMN "permitted_actions"`,
    );
    await queryRunner.query('DROP TYPE "support_access_grant_status_enum"');
  }
}
