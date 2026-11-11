import { MigrationInterface, QueryRunner } from 'typeorm';

/** Durable control-plane bridge for Odoo accounting mutations and audit convergence. */
export class CreateAccountingMutationHandoff1790000000000 implements MigrationInterface {
  name = 'CreateAccountingMutationHandoff1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "accounting_mutation_handoff" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "company_uuid" uuid NOT NULL,
        "actor_account_id" uuid NOT NULL,
        "principal_identity" text NOT NULL,
        "odoo_db_name" text NOT NULL,
        "odoo_company_id" integer NOT NULL,
        "caller_scope" text NOT NULL,
        "method" varchar(10) NOT NULL,
        "route" text NOT NULL,
        "action" text NOT NULL,
        "idempotency_key" text NOT NULL,
        "request_fingerprint" text NOT NULL,
        "request_payload_redacted" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "state" varchar(32) NOT NULL DEFAULT 'pending',
        "final_response" jsonb NULL,
        "retry_count" integer NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz NULL,
        "lease_owner" text NULL,
        "lease_expires_at" timestamptz NULL,
        "last_error_code" text NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "odoo_committed_at" timestamptz NULL,
        "audited_at" timestamptz NULL,
        CONSTRAINT "pk_accounting_mutation_handoff" PRIMARY KEY ("id"),
        CONSTRAINT "uq_accounting_mutation_handoff_scoped_key"
          UNIQUE ("tenant_id", "company_uuid", "actor_account_id", "method", "route", "idempotency_key"),
        CONSTRAINT "ck_accounting_mutation_handoff_state"
          CHECK ("state" IN ('pending', 'odoo_committed', 'audited')),
        CONSTRAINT "ck_accounting_mutation_handoff_retry_count"
          CHECK ("retry_count" >= 0),
        CONSTRAINT "ck_accounting_mutation_handoff_lease_pair"
          CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)),
        CONSTRAINT "ck_accounting_mutation_handoff_final_response"
          CHECK ("state" = 'pending' OR "final_response" IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_accounting_mutation_handoff_recovery"
        ON "accounting_mutation_handoff" ("next_attempt_at", "created_at")
        WHERE "state" <> 'audited'
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_accounting_mutation_handoff_expired_lease"
        ON "accounting_mutation_handoff" ("lease_expires_at")
        WHERE "state" <> 'audited' AND "lease_expires_at" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_accounting_mutation_handoff_operation"
        ON "accounting_mutation_handoff" ("tenant_id", "company_uuid", "id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "accounting_mutation_handoff"');
  }
}
