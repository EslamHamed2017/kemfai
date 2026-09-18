import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T033: creates the `email_verification_token` registry backing FR-021/Edge Cases
 * ("only the most recently issued, unexpired link is honored") and the
 * `POST /accounts/verify-email` contract (200/410).
 *
 * Design notes:
 *   - `token_hash` is the only token material ever stored: the raw token is a 256-bit
 *     random base64url string that lives exclusively in the emailed link (and the
 *     email.send_verification job payload that composes it) — a leaked DB never yields
 *     usable links, and a stolen link is single-use (`consumed_at`).
 *   - `issuance_sequence` is a globally monotonic bigserial, making "the most recently
 *     issued link for an account" a provable ORDER BY instead of a timestamp-tie-prone
 *     comparison; every verification honors only the account's max-sequence row.
 *   - `token_version` mirrors the version component of the email.send_verification job
 *     id (events.md idempotency key: `account_id` + issued token version).
 */
export class CreateEmailVerificationToken1789790000000 implements MigrationInterface {
  name = 'CreateEmailVerificationToken1789790000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "email_verification_token" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "account_id" uuid NOT NULL REFERENCES "account"("id") ON DELETE CASCADE,
        "token_hash" char(64) NOT NULL,
        "token_version" uuid NOT NULL,
        "issuance_sequence" bigserial NOT NULL UNIQUE,
        "issued_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "consumed_at" timestamptz NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_email_verification_token_hash"
      ON "email_verification_token" ("token_hash")
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_email_verification_token_account"
      ON "email_verification_token" ("account_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No separate DROP SEQUENCE: bigserial sequences are OWNED BY the column, so the
    // table drop removes email_verification_token_issuance_sequence_seq with it.
    await queryRunner.query('DROP TABLE "email_verification_token"');
  }
}
