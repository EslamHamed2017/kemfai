import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T020: creates `idempotency_key` in kemfai_control, the persisted claim table backing
 * `IdempotencyKeyInterceptor` (Constitution Principle VII — deterministic, no re-executed
 * side effects on retry).
 *
 * The unique constraint on (scope, idempotency_key, method, path) is the actual dedupe
 * guarantee — enforced by Postgres, not by an application-level check-then-insert race —
 * so two concurrent requests claiming the same key can never both win: exactly one
 * `INSERT ... ON CONFLICT DO NOTHING` succeeds, the other observes the conflict and
 * awaits/replays the winner's result.
 */
export class CreateIdempotencyKey1789720000000 implements MigrationInterface {
  name = 'CreateIdempotencyKey1789720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "idempotency_record_status_enum" AS ENUM ('pending', 'completed')
    `);

    await queryRunner.query(`
      CREATE TABLE "idempotency_key" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "scope" text NOT NULL,
        "idempotency_key" text NOT NULL,
        "method" text NOT NULL,
        "path" text NOT NULL,
        "fingerprint" text NOT NULL,
        "status" "idempotency_record_status_enum" NOT NULL DEFAULT 'pending',
        "response_body" jsonb NULL,
        "locked_at" timestamptz NOT NULL DEFAULT now(),
        "completed_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_idempotency_key_scope_key_route" UNIQUE ("scope", "idempotency_key", "method", "path")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "idempotency_key"');
    await queryRunner.query('DROP TYPE "idempotency_record_status_enum"');
  }
}
