import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T014: creates `audit_event` in kemfai_control — the platform-wide, append-only audit log
 * (data-model.md "AuditEvent", FR-007–FR-009).
 *
 * "Immutable once written" is enforced at the Postgres privilege level, not by application
 * discipline: UPDATE/DELETE are revoked from the `kemfai_api` role (the literal role name
 * `docker-compose.yml`'s `api` service and `infra/docker/init-control-db.sh` already provision as
 * the API/BFF's real runtime connection identity), leaving only SELECT/INSERT. The role name is a
 * hardcoded literal here (not interpolated from configuration) so there is no dynamic-identifier
 * SQL-injection surface in this migration.
 *
 * This migration does not create a login-capable role or embed any credential: if `kemfai_api`
 * does not already exist (e.g. a throwaway test database with no infra bootstrap script), it is
 * created `NOLOGIN` with no password, purely as a privilege container. Enabling it for real
 * authentication (setting `LOGIN` + a password) is done exclusively by infra bootstrap
 * (`init-control-db.sh`) or, for test-only verification, by the test itself — never by a
 * migration, since migrations are applied in every environment including production.
 */
export class CreateAuditEvent1789700000000 implements MigrationInterface {
  name = 'CreateAuditEvent1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "audit_actor_type_enum" AS ENUM ('account', 'internal_user', 'system')
    `);

    await queryRunner.query(`
      CREATE TABLE "audit_event" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "occurred_at" timestamptz NOT NULL DEFAULT now(),
        "actor_type" "audit_actor_type_enum" NOT NULL,
        "actor_id" uuid NULL,
        "tenant_id" uuid NULL,
        "action" text NOT NULL,
        "subject_type" text NOT NULL,
        "subject_id" uuid NOT NULL,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_audit_event_tenant" FOREIGN KEY ("tenant_id")
          REFERENCES "tenant" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_audit_event_system_actor_id" CHECK (
          (actor_type = 'system' AND actor_id IS NULL) OR
          (actor_type <> 'system' AND actor_id IS NOT NULL)
        )
      )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kemfai_api') THEN
          CREATE ROLE "kemfai_api" NOLOGIN;
        END IF;
      END
      $$
    `);

    await queryRunner.query('REVOKE ALL PRIVILEGES ON TABLE "audit_event" FROM "kemfai_api"');
    await queryRunner.query('GRANT SELECT, INSERT ON TABLE "audit_event" TO "kemfai_api"');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "audit_event"');
    await queryRunner.query('DROP TYPE "audit_actor_type_enum"');
  }
}
