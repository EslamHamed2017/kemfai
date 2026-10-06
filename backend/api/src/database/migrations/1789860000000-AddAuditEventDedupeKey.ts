import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T055 remediation — adds a nullable `dedupe_key` column + partial unique index to
 * `audit_event`. This is the durable, DB-enforced anchor that lets a call site turn
 * "append this event" into "ensure this event exists exactly once" via a single
 * `INSERT ... ON CONFLICT ("dedupe_key") DO NOTHING` (same idiom as T020's
 * `idempotency_key` unique constraint and T032's unique-email signup anchor) — without
 * requiring UPDATE/DELETE privileges the T014 migration deliberately revoked from
 * `kemfai_api` (`DO NOTHING` performs no row modification on conflict, so it needs only
 * the INSERT privilege that role already has).
 *
 * `dedupe_key` stays NULL (and unconstrained) for every pre-existing call site: only new
 * call sites that need an "ensure exactly once" write (e.g. `company.setup.completed`,
 * keyed per-tenant; `company.settings.updated`, keyed per-tenant+client-supplied
 * Idempotency-Key) pass one. The partial index only covers non-null values, so it never
 * restricts the many legitimate repeated-action rows (e.g. multiple
 * `tenant.provisioning.attempted` events for the same tenant) that have no dedupe key.
 */
export class AddAuditEventDedupeKey1789860000000 implements MigrationInterface {
  name = 'AddAuditEventDedupeKey1789860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "audit_event" ADD COLUMN "dedupe_key" text NULL');
    await queryRunner.query(
      'CREATE UNIQUE INDEX "uq_audit_event_dedupe_key" ON "audit_event" ("dedupe_key") WHERE "dedupe_key" IS NOT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "uq_audit_event_dedupe_key"');
    await queryRunner.query('ALTER TABLE "audit_event" DROP COLUMN "dedupe_key"');
  }
}
