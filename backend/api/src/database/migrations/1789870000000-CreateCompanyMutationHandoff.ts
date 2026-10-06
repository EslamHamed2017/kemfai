import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T055 arbiter binding resolution, point 1 — `company_mutation_handoff`: the control-plane
 * durable record committed BEFORE the Odoo RPC for a company-mutating action (setup
 * completion or settings update) that must converge to exactly one business event even
 * across a lost RPC response, a process crash, or an audit-store failure. See
 * `CompanyMutationHandoff` entity for the full field-by-field rationale.
 *
 * Two partial unique indexes carry the actual dedupe guarantees (never an application-level
 * check-then-insert race):
 * - `uq_company_mutation_handoff_completion`: at most one `setup.complete` handoff per
 *   tenant, ever — this is what reconciles operation-UUID dedupe with AC3.7's "exactly one
 *   company.setup.completed event per actual company completion" when separate HTTP
 *   requests carry different/no client keys: they all resolve to this SAME row.
 * - `uq_company_mutation_handoff_key_scope`: at most one `settings.update` handoff per
 *   (caller_scope, tenant_id, method, route, idempotency_key) when a client key is present;
 *   absent a key, no row collides with another (point 5 — distinct new intent).
 */
export class CreateCompanyMutationHandoff1789870000000 implements MigrationInterface {
  name = 'CreateCompanyMutationHandoff1789870000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "company_mutation_action_enum" AS ENUM ('setup.complete', 'settings.update')
    `);
    await queryRunner.query(`
      CREATE TYPE "company_mutation_handoff_state_enum" AS ENUM ('pending', 'odoo_committed', 'audited', 'failed')
    `);

    await queryRunner.query(`
      CREATE TABLE "company_mutation_handoff" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "action" "company_mutation_action_enum" NOT NULL,
        "tenant_id" uuid NOT NULL,
        "actor_account_id" uuid NOT NULL,
        "principal_identity" text NOT NULL,
        "odoo_db_name" text NOT NULL,
        "odoo_company_id" int NOT NULL,
        "request_fingerprint" text NOT NULL,
        "request_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "occurred_at" timestamptz NOT NULL,
        "idempotency_key" text NULL,
        "caller_scope" text NULL,
        "method" text NULL,
        "route" text NULL,
        "state" "company_mutation_handoff_state_enum" NOT NULL DEFAULT 'pending',
        "retry_count" int NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz NULL,
        "final_response" jsonb NULL,
        "lease_owner" text NULL,
        "lease_expires_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_company_mutation_handoff_tenant" FOREIGN KEY ("tenant_id") REFERENCES "tenant" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_company_mutation_handoff_actor" FOREIGN KEY ("actor_account_id") REFERENCES "account" ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_company_mutation_handoff_completion"
        ON "company_mutation_handoff" ("tenant_id")
        WHERE "action" = 'setup.complete'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_company_mutation_handoff_key_scope"
        ON "company_mutation_handoff" ("caller_scope", "tenant_id", "method", "route", "idempotency_key")
        WHERE "idempotency_key" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_company_mutation_handoff_recovery"
        ON "company_mutation_handoff" ("state", "next_attempt_at")
        WHERE "state" IN ('pending', 'odoo_committed')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "ix_company_mutation_handoff_recovery"');
    await queryRunner.query('DROP INDEX "uq_company_mutation_handoff_key_scope"');
    await queryRunner.query('DROP INDEX "uq_company_mutation_handoff_completion"');
    await queryRunner.query('DROP TABLE "company_mutation_handoff"');
    await queryRunner.query('DROP TYPE "company_mutation_handoff_state_enum"');
    await queryRunner.query('DROP TYPE "company_mutation_action_enum"');
  }
}
