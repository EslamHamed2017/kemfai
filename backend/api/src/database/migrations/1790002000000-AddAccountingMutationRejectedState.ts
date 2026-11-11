import { MigrationInterface, QueryRunner } from 'typeorm';

/** Terminal deterministic rejections must never be replayed by recovery workers. */
export class AddAccountingMutationRejectedState1790002000000 implements MigrationInterface {
  name = 'AddAccountingMutationRejectedState1790002000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "ix_accounting_mutation_handoff_recovery"');
    await queryRunner.query('DROP INDEX IF EXISTS "ix_accounting_mutation_handoff_expired_lease"');
    await queryRunner.query(
      'ALTER TABLE "accounting_mutation_handoff" DROP CONSTRAINT "ck_accounting_mutation_handoff_final_response"',
    );
    await queryRunner.query(
      'ALTER TABLE "accounting_mutation_handoff" DROP CONSTRAINT "ck_accounting_mutation_handoff_state"',
    );
    await queryRunner.query(
      `ALTER TABLE "accounting_mutation_handoff" ADD CONSTRAINT "ck_accounting_mutation_handoff_state" CHECK ("state" IN ('pending', 'rejected', 'odoo_committed', 'audited'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "accounting_mutation_handoff" ADD CONSTRAINT "ck_accounting_mutation_handoff_final_response" CHECK ("state" IN ('pending', 'rejected') OR "final_response" IS NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_accounting_mutation_handoff_recovery" ON "accounting_mutation_handoff" ("next_attempt_at", "created_at") WHERE "state" IN ('pending', 'odoo_committed')`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_accounting_mutation_handoff_expired_lease" ON "accounting_mutation_handoff" ("lease_expires_at") WHERE "state" IN ('pending', 'odoo_committed') AND "lease_expires_at" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "accounting_mutation_handoff" WHERE "state" = 'rejected') THEN
          RAISE EXCEPTION 'cannot rollback rejected accounting handoffs; resolve or retain migration 1790002000000';
        END IF;
      END $$`);
    await queryRunner.query('DROP INDEX IF EXISTS "ix_accounting_mutation_handoff_recovery"');
    await queryRunner.query('DROP INDEX IF EXISTS "ix_accounting_mutation_handoff_expired_lease"');
    await queryRunner.query(
      'ALTER TABLE "accounting_mutation_handoff" DROP CONSTRAINT "ck_accounting_mutation_handoff_final_response"',
    );
    await queryRunner.query(
      'ALTER TABLE "accounting_mutation_handoff" DROP CONSTRAINT "ck_accounting_mutation_handoff_state"',
    );
    await queryRunner.query(
      `ALTER TABLE "accounting_mutation_handoff" ADD CONSTRAINT "ck_accounting_mutation_handoff_state" CHECK ("state" IN ('pending', 'odoo_committed', 'audited'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "accounting_mutation_handoff" ADD CONSTRAINT "ck_accounting_mutation_handoff_final_response" CHECK ("state" = 'pending' OR "final_response" IS NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_accounting_mutation_handoff_recovery" ON "accounting_mutation_handoff" ("next_attempt_at", "created_at") WHERE "state" <> 'audited'`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_accounting_mutation_handoff_expired_lease" ON "accounting_mutation_handoff" ("lease_expires_at") WHERE "state" <> 'audited' AND "lease_expires_at" IS NOT NULL`,
    );
  }
}
