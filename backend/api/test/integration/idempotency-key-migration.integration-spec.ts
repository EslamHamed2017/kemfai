import controlDataSource from '../../src/database/data-source';
import {
  IdempotencyKeyRecord,
  IdempotencyRecordStatus,
} from '../../src/modules/idempotency/entities/idempotency-key.entity';

/**
 * T020 migration acceptance test. Requires a reachable Postgres configured via CONTROL_DB_*
 * env vars, same convention as every other migration integration spec in this suite.
 *
 * The unique constraint asserted here is the actual concurrency guarantee
 * `IdempotencyKeyInterceptor` relies on: two concurrent claims for the same
 * (scope, idempotency_key, method, path) can never both succeed at the database level, so
 * the interceptor's `INSERT ... ON CONFLICT DO NOTHING` genuinely picks exactly one winner
 * without any application-level locking.
 */
describe('IdempotencyKey migration + entity (T020)', () => {
  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();
  });

  afterEach(async () => {
    await controlDataSource.query('DELETE FROM "idempotency_key"');
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  it('persists a claimed row with every documented field', async () => {
    const repo = controlDataSource.getRepository(IdempotencyKeyRecord);

    const saved = await repo.save(
      repo.create({
        scope: 'anonymous',
        idempotencyKey: 'key-1',
        method: 'POST',
        path: '/accounts',
        fingerprint: 'abc123',
        status: IdempotencyRecordStatus.PENDING,
        responseBody: null,
        lockedAt: new Date(),
        createdAt: new Date(),
      }),
    );

    const reloaded = await repo.findOneByOrFail({ id: saved.id });
    expect(reloaded.scope).toBe('anonymous');
    expect(reloaded.idempotencyKey).toBe('key-1');
    expect(reloaded.method).toBe('POST');
    expect(reloaded.path).toBe('/accounts');
    expect(reloaded.fingerprint).toBe('abc123');
    expect(reloaded.status).toBe(IdempotencyRecordStatus.PENDING);
    expect(reloaded.responseBody).toBeNull();
    expect(reloaded.completedAt).toBeNull();
  });

  it('rejects a second row for the same (scope, idempotency_key, method, path) at the database level', async () => {
    await controlDataSource.query(
      `INSERT INTO "idempotency_key" ("scope", "idempotency_key", "method", "path", "fingerprint", "status")
       VALUES ('anonymous', 'key-1', 'POST', '/accounts', 'fp-1', 'pending')`,
    );

    await expect(
      controlDataSource.query(
        `INSERT INTO "idempotency_key" ("scope", "idempotency_key", "method", "path", "fingerprint", "status")
         VALUES ('anonymous', 'key-1', 'POST', '/accounts', 'fp-2', 'pending')`,
      ),
    ).rejects.toThrow(/duplicate key value/i);
  });

  it('allows the same idempotency_key across different scopes, methods, or paths', async () => {
    await controlDataSource.query(
      `INSERT INTO "idempotency_key" ("scope", "idempotency_key", "method", "path", "fingerprint", "status")
       VALUES ('anonymous', 'key-1', 'POST', '/accounts', 'fp-1', 'pending')`,
    );

    await expect(
      controlDataSource.query(
        `INSERT INTO "idempotency_key" ("scope", "idempotency_key", "method", "path", "fingerprint", "status")
         VALUES ('keycloak:user-1', 'key-1', 'POST', '/accounts', 'fp-1', 'pending')`,
      ),
    ).resolves.not.toThrow();

    await expect(
      controlDataSource.query(
        `INSERT INTO "idempotency_key" ("scope", "idempotency_key", "method", "path", "fingerprint", "status")
         VALUES ('anonymous', 'key-1', 'POST', '/other-resource', 'fp-1', 'pending')`,
      ),
    ).resolves.not.toThrow();
  });

  it('an ON CONFLICT DO NOTHING claim attempt returns no row when the slot is already taken (the exact claim query)', async () => {
    const first = await controlDataSource.query(
      `INSERT INTO "idempotency_key" ("scope", "idempotency_key", "method", "path", "fingerprint", "status", "locked_at")
       VALUES ('anonymous', 'key-race', 'POST', '/accounts', 'fp-1', 'pending', now())
       ON CONFLICT ("scope", "idempotency_key", "method", "path") DO NOTHING
       RETURNING "id"`,
    );
    expect(first).toHaveLength(1);

    const second = await controlDataSource.query(
      `INSERT INTO "idempotency_key" ("scope", "idempotency_key", "method", "path", "fingerprint", "status", "locked_at")
       VALUES ('anonymous', 'key-race', 'POST', '/accounts', 'fp-1', 'pending', now())
       ON CONFLICT ("scope", "idempotency_key", "method", "path") DO NOTHING
       RETURNING "id"`,
    );
    expect(second).toHaveLength(0);
  });

  it('the status enum matches pending|completed exactly', async () => {
    const rows = await controlDataSource.query(`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'idempotency_record_status_enum'
      ORDER BY e.enumsortorder
    `);
    const labels = rows.map((r: { enumlabel: string }) => r.enumlabel);
    expect(labels).toEqual(['pending', 'completed']);
  });
});
