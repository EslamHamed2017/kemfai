import { MigrationInterface, QueryRunner } from 'typeorm';

export class SeedOnboardingChecklistFeatureFlag1789910000000 implements MigrationInterface {
  name = 'SeedOnboardingChecklistFeatureFlag1789910000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`INSERT INTO "feature" ("id","key","display_name","kind")
      VALUES (gen_random_uuid(),'module.onboarding_checklist','Onboarding checklist (US7)','module')
      ON CONFLICT ("key") DO NOTHING`);
    await queryRunner.query(`INSERT INTO "feature_flag" ("feature_key","enabled","notes")
      VALUES ('module.onboarding_checklist',false,'US7 release gate; enable only after acceptance.')
      ON CONFLICT ("feature_key") DO NOTHING`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "feature_flag" WHERE "feature_key"='module.onboarding_checklist'`,
    );
    await queryRunner.query(`DELETE FROM "feature" WHERE "key"='module.onboarding_checklist'`);
  }
}
