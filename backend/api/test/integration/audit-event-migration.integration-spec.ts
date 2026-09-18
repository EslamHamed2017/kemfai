import { DataSource } from 'typeorm';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { AuditActorType, AuditEvent } from '../../src/modules/audit/entities/audit-event.entity';
import { Tenant } from '../../src/modules/tenants/entities/tenant.entity';

/**
 * T014 acceptance test. Requires a reachable Postgres configured via CONTROL_DB_* env vars, same
 * convention as T007-T013's migration integration specs.
 *
 * Proves the FR-008 "immutable once written" invariant against the *exact* role name
 * (`kemfai_api`) that `infra/docker/docker-compose.yml`'s `api` service and
 * `infra/docker/init-control-db.sh` configure as the API/BFF's real runtime database identity —
 * not an unrelated test-only role. `ALTER ROLE ... LOGIN PASSWORD` below is test-only credential
 * bootstrapping (mirrors every other spec in this suite hardcoding a dev-only Postgres password to
 * open a connection) so this test is self-sufficient against a throwaway database that never ran
 * infra's bootstrap script; the migration itself never sets a password (see migration comment).
 */
describe('AuditEvent migration + entity (T014)', () => {
  const API_ROLE_TEST_PASSWORD = 'kemfai_api_test_only';
  let appRoleDataSource: DataSource;

  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    // Test-only: ensure the role can authenticate directly as itself, regardless of whether this
    // database was bootstrapped by infra/docker/init-control-db.sh (which already sets a LOGIN
    // password) or is a bare throwaway database where the migration created it NOLOGIN.
    await controlDataSource.query(
      `ALTER ROLE "kemfai_api" WITH LOGIN PASSWORD '${API_ROLE_TEST_PASSWORD}'`,
    );

    appRoleDataSource = new DataSource({
      type: 'postgres',
      host: process.env.CONTROL_DB_HOST ?? 'localhost',
      port: Number(process.env.CONTROL_DB_PORT ?? 5432),
      database: process.env.CONTROL_DB_NAME ?? 'kemfai_control',
      username: 'kemfai_api',
      password: API_ROLE_TEST_PASSWORD,
    });
    await appRoleDataSource.initialize();
  });

  afterEach(async () => {
    await controlDataSource.query('DELETE FROM "audit_event"');
    await controlDataSource.query('DELETE FROM "tenant"');
    await controlDataSource.query('DELETE FROM "account"');
  });

  afterAll(async () => {
    if (appRoleDataSource?.isInitialized) {
      await appRoleDataSource.destroy();
    }
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  async function createAccount(email: string) {
    const repo = controlDataSource.getRepository(Account);
    return repo.save(
      repo.create({
        keycloakUserId: '11111111-1111-1111-1111-111111111111',
        email,
        emailVerified: true,
        mfaEnrolled: false,
      }),
    );
  }

  async function createTenant(accountId: string) {
    const repo = controlDataSource.getRepository(Tenant);
    return repo.save(repo.create({ accountId }));
  }

  it("matches data-model.md's AuditEvent table: persists every documented field verbatim", async () => {
    const account = await createAccount('owner-a@example.com');
    const tenant = await createTenant(account.id);
    const repo = controlDataSource.getRepository(AuditEvent);

    const saved = await repo.save(
      repo.create({
        occurredAt: new Date('2026-02-01T00:00:00.000Z'),
        actorType: AuditActorType.ACCOUNT,
        actorId: account.id,
        tenantId: tenant.id,
        action: 'tenant.provisioning.succeeded',
        subjectType: 'tenant',
        subjectId: tenant.id,
        payload: { odooDbName: 'kemfai_tenant_abc' },
      }),
    );

    const reloaded = await repo.findOneByOrFail({ id: saved.id });
    expect(reloaded.occurredAt).toBeInstanceOf(Date);
    expect(reloaded.actorType).toBe(AuditActorType.ACCOUNT);
    expect(reloaded.actorId).toBe(account.id);
    expect(reloaded.tenantId).toBe(tenant.id);
    expect(reloaded.action).toBe('tenant.provisioning.succeeded');
    expect(reloaded.subjectType).toBe('tenant');
    expect(reloaded.subjectId).toBe(tenant.id);
    expect(reloaded.payload).toEqual({ odooDbName: 'kemfai_tenant_abc' });
    expect(reloaded.createdAt).toBeInstanceOf(Date);
  });

  it('allows tenant_id and actor_id to be null for a pre-tenant system event', async () => {
    const repo = controlDataSource.getRepository(AuditEvent);

    const saved = await repo.save(
      repo.create({
        occurredAt: new Date('2026-02-01T00:00:00.000Z'),
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        tenantId: null,
        action: 'account.created',
        subjectType: 'account',
        subjectId: '99999999-9999-9999-9999-999999999999',
        payload: {},
      }),
    );

    const reloaded = await repo.findOneByOrFail({ id: saved.id });
    expect(reloaded.actorId).toBeNull();
    expect(reloaded.tenantId).toBeNull();
  });

  it('rejects a non-system actor with a null actor_id at the database level', async () => {
    const repo = controlDataSource.getRepository(AuditEvent);

    await expect(
      repo.save(
        repo.create({
          occurredAt: new Date('2026-02-01T00:00:00.000Z'),
          actorType: AuditActorType.ACCOUNT,
          actorId: null,
          tenantId: null,
          action: 'account.created',
          subjectType: 'account',
          subjectId: '99999999-9999-9999-9999-999999999999',
          payload: {},
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects a system actor with a non-null actor_id at the database level', async () => {
    const account = await createAccount('owner-b@example.com');
    const repo = controlDataSource.getRepository(AuditEvent);

    await expect(
      repo.save(
        repo.create({
          occurredAt: new Date('2026-02-01T00:00:00.000Z'),
          actorType: AuditActorType.SYSTEM,
          actorId: account.id,
          tenantId: null,
          action: 'account.created',
          subjectType: 'account',
          subjectId: account.id,
          payload: {},
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects an audit event referencing a nonexistent tenant (FK constraint)', async () => {
    const repo = controlDataSource.getRepository(AuditEvent);

    await expect(
      repo.save(
        repo.create({
          occurredAt: new Date('2026-02-01T00:00:00.000Z'),
          actorType: AuditActorType.SYSTEM,
          actorId: null,
          tenantId: '99999999-9999-9999-9999-999999999999',
          action: 'account.created',
          subjectType: 'account',
          subjectId: '99999999-9999-9999-9999-999999999999',
          payload: {},
        }),
      ),
    ).rejects.toThrow();
  });

  it('the actor_type enum matches account|internal_user|system exactly', async () => {
    const rows = await controlDataSource.query(`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'audit_actor_type_enum'
      ORDER BY e.enumsortorder
    `);
    const labels = rows.map((r: { enumlabel: string }) => r.enumlabel);
    expect(labels).toEqual(['account', 'internal_user', 'system']);
  });

  it("the API/BFF's real runtime role (kemfai_api) can INSERT into audit_event", async () => {
    await expect(
      appRoleDataSource.query(
        `INSERT INTO "audit_event"
           ("occurred_at", "actor_type", "actor_id", "tenant_id", "action", "subject_type", "subject_id", "payload")
         VALUES (now(), 'system', NULL, NULL, 'account.created', 'account', $1, '{}'::jsonb)`,
        ['99999999-9999-9999-9999-999999999999'],
      ),
    ).resolves.not.toThrow();
  });

  it("the API/BFF's real runtime role (kemfai_api) cannot UPDATE audit_event rows (FR-008 immutability, DB-enforced)", async () => {
    const repo = controlDataSource.getRepository(AuditEvent);
    const saved = await repo.save(
      repo.create({
        occurredAt: new Date('2026-02-01T00:00:00.000Z'),
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        tenantId: null,
        action: 'account.created',
        subjectType: 'account',
        subjectId: '99999999-9999-9999-9999-999999999999',
        payload: {},
      }),
    );

    await expect(
      appRoleDataSource.query(`UPDATE "audit_event" SET "action" = 'tampered' WHERE "id" = $1`, [
        saved.id,
      ]),
    ).rejects.toThrow(/permission denied/i);
  });

  it("the API/BFF's real runtime role (kemfai_api) cannot DELETE audit_event rows (FR-008 immutability, DB-enforced)", async () => {
    const repo = controlDataSource.getRepository(AuditEvent);
    const saved = await repo.save(
      repo.create({
        occurredAt: new Date('2026-02-01T00:00:00.000Z'),
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        tenantId: null,
        action: 'account.created',
        subjectType: 'account',
        subjectId: '99999999-9999-9999-9999-999999999999',
        payload: {},
      }),
    );

    await expect(
      appRoleDataSource.query(`DELETE FROM "audit_event" WHERE "id" = $1`, [saved.id]),
    ).rejects.toThrow(/permission denied/i);
  });
});
