import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Additive compatibility migration for both fresh installs and environments that
 * already ran the immutable 1789890000000 migration. Every new object is created
 * before it is referenced. IF NOT EXISTS also accepts an intermediate review schema
 * without overwriting its immutable provider payload or terminal evidence.
 */
export class EnforceBillingDecisionNotificationTerminalState1789891000000 implements MigrationInterface {
  name = 'EnforceBillingDecisionNotificationTerminalState1789891000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "billing_decision_notification_outbox"
        ADD COLUMN IF NOT EXISTS "decision_occurrence" int NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "delivered_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "first_send_attempted_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "provider_request_body" text NULL,
        ADD COLUMN IF NOT EXISTS "provider_message_id" text NULL,
        ADD COLUMN IF NOT EXISTS "quarantined_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "delivery_rejected_at" timestamptz NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "billing_decision_notification_outbox"
        ALTER COLUMN "decision_occurrence" DROP DEFAULT
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_billing_decision_notification_outbox_ambiguous_sweep"
        ON "billing_decision_notification_outbox" ("first_send_attempted_at")
        WHERE "delivered_at" IS NULL
          AND "quarantined_at" IS NULL
          AND "delivery_rejected_at" IS NULL
    `);
    await queryRunner.query(`
      UPDATE "billing_decision_notification_outbox"
         SET "delivery_rejected_at" = CASE WHEN "delivered_at" IS NOT NULL THEN NULL ELSE "delivery_rejected_at" END,
             "quarantined_at" = CASE
               WHEN "delivered_at" IS NOT NULL OR "delivery_rejected_at" IS NOT NULL THEN NULL
               ELSE "quarantined_at"
             END,
             "updated_at" = now()
       WHERE num_nonnulls("delivered_at", "delivery_rejected_at", "quarantined_at") > 1
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'ck_billing_decision_notification_outbox_terminal_state'
             AND conrelid = 'billing_decision_notification_outbox'::regclass
        ) THEN
          ALTER TABLE "billing_decision_notification_outbox"
            ADD CONSTRAINT "ck_billing_decision_notification_outbox_terminal_state"
            CHECK (num_nonnulls("delivered_at", "delivery_rejected_at", "quarantined_at") <= 1);
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // TypeORM normally wraps `down` in a transaction. Direct QueryRunner callers do
    // not necessarily do so, and PostgreSQL releases a LOCK at statement end outside
    // a transaction. Own a transaction only when the caller has not supplied one;
    // otherwise leave the caller/TypeORM fully responsible for its lifecycle.
    const transactionStartedHere = !queryRunner.isTransactionActive;
    if (transactionStartedHere) await queryRunner.startTransaction();
    try {
      // ACCESS EXCLUSIVE conflicts with every concurrent reader/writer table lock and
      // is retained through the final DROP COLUMN by the surrounding transaction.
      // Therefore no provider evidence can commit after the guard but before the DDL.
      await queryRunner.query(`
        LOCK TABLE "billing_decision_notification_outbox" IN ACCESS EXCLUSIVE MODE
      `);
      // A rollback may remove only empty additive state. Refuse rather than silently
      // destroy an immutable request body, provider receipt, or reconciliation marker.
      await queryRunner.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM "billing_decision_notification_outbox"
             WHERE "first_send_attempted_at" IS NOT NULL
                OR "provider_request_body" IS NOT NULL
                OR "provider_message_id" IS NOT NULL
                OR "quarantined_at" IS NOT NULL
                OR "delivery_rejected_at" IS NOT NULL
          ) THEN
            RAISE EXCEPTION 'refusing to remove T070 delivery columns containing durable evidence';
          END IF;
        END $$
      `);
      await queryRunner.query(`
        ALTER TABLE "billing_decision_notification_outbox"
          DROP CONSTRAINT IF EXISTS "ck_billing_decision_notification_outbox_terminal_state"
      `);
      await queryRunner.query(`
        DROP INDEX IF EXISTS "ix_billing_decision_notification_outbox_ambiguous_sweep"
      `);
      await queryRunner.query(`
        ALTER TABLE "billing_decision_notification_outbox"
          DROP COLUMN IF EXISTS "delivery_rejected_at",
          DROP COLUMN IF EXISTS "quarantined_at",
          DROP COLUMN IF EXISTS "provider_message_id",
          DROP COLUMN IF EXISTS "provider_request_body",
          DROP COLUMN IF EXISTS "first_send_attempted_at"
      `);
      if (transactionStartedHere) await queryRunner.commitTransaction();
    } catch (error) {
      if (transactionStartedHere && queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    }
  }
}
