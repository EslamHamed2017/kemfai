import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T070 durability (Codex review finding 1) — `billing_decision_notification_outbox`:
 * the durable handoff record for FR-035 customer notifications, committed INSIDE the
 * same PostgreSQL transaction as the billing decision, its status flip, its history
 * append, and its FR-009 audit event. The BullMQ enqueue to Redis happens only AFTER
 * that transaction resolves, so an enqueue failure or a process crash between commit
 * and enqueue can never lose the notification: the row stays `pending` until the
 * recovery worker (or the operator recovery command) re-enqueues it.
 *
 * This mirrors the established `company_mutation_handoff` durability pattern (T055):
 *
 * - `uq_billing_decision_notification_outbox_job_id`: the BullMQ job id
 *   (`submission_id` + decision + decision occurrence, per contracts/events.md) is
 *   unique — one outbox row (and therefore one job) per decision occurrence, ever.
 *   Repeated more-info cycles on the same submission row each get their own
 *   occurrence-keyed row (review finding 2).
 * - `ix_..._recovery`: partial index the recovery claim scans — only rows still
 *   `pending`, ordered by the backoff window.
 * - FK `ON DELETE CASCADE` to `payment_submission`/`tenant`: an outbox row is
 *   meaningless without its submission (billing rows are append-only in production;
 *   the cascade exists so data-retention deletions and test fixtures cannot strand
 *   orphaned notification intents).
 */
export class CreateBillingDecisionNotificationOutbox1789890000000 implements MigrationInterface {
  name = 'CreateBillingDecisionNotificationOutbox1789890000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "billing_decision_notification_state_enum" AS ENUM ('pending', 'enqueued')
    `);
    await queryRunner.query(`
      CREATE TABLE "billing_decision_notification_outbox" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "submission_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "decision" text NOT NULL,
        "notes" text NULL,
        "occurred_at" timestamptz NOT NULL,
        "job_id" text NOT NULL,
        "state" "billing_decision_notification_state_enum" NOT NULL DEFAULT 'pending',
        "retry_count" int NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz NULL,
        "lease_owner" text NULL,
        "lease_expires_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_billing_decision_notification_outbox_job_id" UNIQUE ("job_id"),
        CONSTRAINT "fk_billing_decision_notification_outbox_submission"
          FOREIGN KEY ("submission_id") REFERENCES "payment_submission" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_billing_decision_notification_outbox_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenant" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_billing_decision_notification_outbox_recovery"
        ON "billing_decision_notification_outbox" ("state", "next_attempt_at")
        WHERE "state" = 'pending'
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_billing_decision_notification_outbox_submission"
        ON "billing_decision_notification_outbox" ("submission_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "ix_billing_decision_notification_outbox_submission"');
    await queryRunner.query('DROP INDEX "ix_billing_decision_notification_outbox_recovery"');
    await queryRunner.query('DROP TABLE "billing_decision_notification_outbox"');
    await queryRunner.query('DROP TYPE "billing_decision_notification_state_enum"');
  }
}
