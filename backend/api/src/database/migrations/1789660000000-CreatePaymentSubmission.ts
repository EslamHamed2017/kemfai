import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T012: creates the `payment_submission` table in kemfai_control — a customer's claim of payment
 * for one billing period (data-model.md "PaymentSubmission", FR-032–FR-036).
 *
 * Three DB-level guarantees beyond the column list, all required by FR-033/Constitution Principle
 * VII (enforce invariants at the database, not just in application code):
 *
 * 1. `uq_payment_submission_unresolved_period` — a partial unique index on
 *    `(tenant_id, billing_period_start, billing_period_end)` WHERE status is still unresolved
 *    (`PendingReview` or `MoreInfoRequested`) blocks a second concurrent submission for the same
 *    tenant+period, while still allowing a new submission once the prior one reaches a terminal
 *    review outcome.
 * 2. `payment_submission_status_history_append_only` — a BEFORE UPDATE trigger that rejects any
 *    UPDATE which would shrink, reorder, or rewrite existing `status_history` entries; only
 *    appending new entries onto the end of the array is permitted. This alone does not constrain
 *    INSERT, so guarantee 3 below covers the initial shape.
 * 3. `ck_payment_submission_status_history_is_array` — a CHECK constraint requiring
 *    `jsonb_typeof(status_history) = 'array'` on every INSERT and UPDATE, so `status_history` can
 *    never be persisted as a scalar/object instead of the required append-only jsonb array.
 *
 * `subscription_id` is enforced via a composite FK `(tenant_id, subscription_id) REFERENCES
 * subscription(tenant_id, id)` rather than a plain `subscription_id -> subscription(id)` FK, so
 * that a row can never pair one tenant's `tenant_id` with a different tenant's `subscription_id` —
 * Postgres itself rejects the mismatch. This requires `subscription` to carry a composite
 * `UNIQUE (tenant_id, id)` constraint (added here, alongside T011's existing single-column
 * `UNIQUE (tenant_id)` — both coexist since `id` is already unique on its own).
 */
export class CreatePaymentSubmission1789660000000 implements MigrationInterface {
  name = 'CreatePaymentSubmission1789660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subscription" ADD CONSTRAINT "uq_subscription_tenant_id_id" UNIQUE ("tenant_id", "id")
    `);

    await queryRunner.query(`
      CREATE TYPE "payment_submission_status_enum" AS ENUM
        ('PendingReview', 'Approved', 'Rejected', 'MoreInfoRequested')
    `);

    await queryRunner.query(`
      CREATE TABLE "payment_submission" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "subscription_id" uuid NOT NULL,
        "billing_period_start" date NOT NULL,
        "billing_period_end" date NOT NULL,
        "amount" numeric(12,2) NOT NULL,
        "currency" char(3) NOT NULL,
        "bank_reference" text NOT NULL,
        "proof_object_key" text NOT NULL,
        "status" "payment_submission_status_enum" NOT NULL DEFAULT 'PendingReview',
        "submitted_at" timestamptz NOT NULL DEFAULT now(),
        "reviewed_by" uuid NULL,
        "reviewed_at" timestamptz NULL,
        "decision_notes" text NULL,
        "status_history" jsonb NOT NULL DEFAULT '[]'::jsonb,
        CONSTRAINT "fk_payment_submission_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_payment_submission_tenant_subscription" FOREIGN KEY ("tenant_id", "subscription_id")
          REFERENCES "subscription" ("tenant_id", "id") ON DELETE RESTRICT,
        CONSTRAINT "fk_payment_submission_reviewed_by" FOREIGN KEY ("reviewed_by")
          REFERENCES "account" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_payment_submission_status_history_is_array"
          CHECK (jsonb_typeof("status_history") = 'array')
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_payment_submission_bank_reference" ON "payment_submission" ("bank_reference")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_payment_submission_unresolved_period" ON "payment_submission"
        ("tenant_id", "billing_period_start", "billing_period_end")
        WHERE "status" IN ('PendingReview', 'MoreInfoRequested')
    `);

    await queryRunner.query(`
      CREATE FUNCTION "payment_submission_status_history_append_only"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      DECLARE
        old_len integer := jsonb_array_length(OLD.status_history);
        new_len integer := jsonb_array_length(NEW.status_history);
        prefix jsonb;
      BEGIN
        IF new_len < old_len THEN
          RAISE EXCEPTION 'status_history is append-only: cannot remove existing entries';
        END IF;

        IF old_len > 0 THEN
          SELECT jsonb_agg(elem ORDER BY ord)
          INTO prefix
          FROM jsonb_array_elements(NEW.status_history) WITH ORDINALITY AS t(elem, ord)
          WHERE ord <= old_len;

          IF prefix IS DISTINCT FROM OLD.status_history THEN
            RAISE EXCEPTION
              'status_history is append-only: existing entries cannot be modified or reordered';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $fn$
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_payment_submission_status_history_append_only"
      BEFORE UPDATE ON "payment_submission"
      FOR EACH ROW
      EXECUTE FUNCTION "payment_submission_status_history_append_only"()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TRIGGER "trg_payment_submission_status_history_append_only" ON "payment_submission"',
    );
    await queryRunner.query('DROP FUNCTION "payment_submission_status_history_append_only"()');
    await queryRunner.query('DROP TABLE "payment_submission"');
    await queryRunner.query('DROP TYPE "payment_submission_status_enum"');
    await queryRunner.query(
      'ALTER TABLE "subscription" DROP CONSTRAINT "uq_subscription_tenant_id_id"',
    );
  }
}
