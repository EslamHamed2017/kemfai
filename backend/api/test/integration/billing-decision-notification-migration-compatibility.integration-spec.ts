import { randomUUID } from 'node:crypto';
import { DataSource, type DataSourceOptions, type MigrationInterface } from 'typeorm';
import { controlDataSourceOptions } from '../../src/database/data-source';
import { CreateBillingDecisionNotificationOutbox1789890000000 } from '../../src/database/migrations/1789890000000-CreateBillingDecisionNotificationOutbox';
import { EnforceBillingDecisionNotificationTerminalState1789891000000 } from '../../src/database/migrations/1789891000000-EnforceBillingDecisionNotificationTerminalState';

const ORIGINAL = CreateBillingDecisionNotificationOutbox1789890000000;
const ADDITIVE = EnforceBillingDecisionNotificationTerminalState1789891000000;
const NEW_COLUMNS = [
  'first_send_attempted_at',
  'provider_request_body',
  'provider_message_id',
  'quarantined_at',
  'delivery_rejected_at',
];

/**
 * Requires an owned disposable PostgreSQL fixture. Every case uses and drops a unique
 * schema, never production/shared state. Phase one deliberately runs only the restored
 * immutable 1789890000000 migration and records it in TypeORM's migration ledger;
 * phase two adds 1789891000000 and proves TypeORM runs only that outstanding migration.
 */
describe('T070 outbox additive migration compatibility (real PostgreSQL)', () => {
  const liveSources = new Set<DataSource>();
  const bootstrap = new DataSource({
    ...controlDataSourceOptions,
    entities: [],
    migrations: [],
  } as DataSourceOptions);

  beforeAll(async () => bootstrap.initialize());
  afterAll(async () => {
    if (bootstrap.isInitialized) await bootstrap.destroy();
  });

  function dataSource(schema: string, migrations: Array<new () => MigrationInterface>): DataSource {
    const priorExtra = (controlDataSourceOptions.extra ?? {}) as Record<string, unknown>;
    const source = new DataSource({
      ...controlDataSourceOptions,
      schema,
      entities: [],
      migrations,
      migrationsTableName: 'migrations',
      extra: { ...priorExtra, options: `-c search_path=${schema}` },
    } as DataSourceOptions);
    liveSources.add(source);
    return source;
  }

  async function withOriginalSchema(
    run: (source: DataSource, schema: string) => Promise<void>,
  ): Promise<void> {
    const schema = `t070_migration_${randomUUID().replaceAll('-', '')}`;
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const source = dataSource(schema, [ORIGINAL]);
    try {
      await source.initialize();
      await source.query('CREATE TABLE "tenant" ("id" uuid PRIMARY KEY)');
      await source.query('CREATE TABLE "payment_submission" ("id" uuid PRIMARY KEY)');
      await source.runMigrations();
      expect(await migrationNames(source)).toEqual([
        'CreateBillingDecisionNotificationOutbox1789890000000',
      ]);
      await run(source, schema);
    } finally {
      for (const candidate of liveSources) {
        if ((candidate.options as DataSourceOptions & { schema?: string }).schema === schema) {
          if (candidate.isInitialized) await candidate.destroy();
          liveSources.delete(candidate);
        }
      }
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  }

  async function upgrade(source: DataSource, schema: string): Promise<DataSource> {
    await source.destroy();
    const upgraded = dataSource(schema, [ORIGINAL, ADDITIVE]);
    await upgraded.initialize();
    const applied = await upgraded.runMigrations();
    expect(applied.map((migration) => migration.name)).toEqual([
      'EnforceBillingDecisionNotificationTerminalState1789891000000',
    ]);
    return upgraded;
  }

  it('installs the immutable baseline and additive migration together on a fresh schema', async () => {
    const schema = `t070_migration_${randomUUID().replaceAll('-', '')}`;
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const fresh = dataSource(schema, [ORIGINAL, ADDITIVE]);
    try {
      await fresh.initialize();
      await fresh.query('CREATE TABLE "tenant" ("id" uuid PRIMARY KEY)');
      await fresh.query('CREATE TABLE "payment_submission" ("id" uuid PRIMARY KEY)');
      const applied = await fresh.runMigrations();
      expect(applied.map((migration) => migration.name)).toEqual([
        'CreateBillingDecisionNotificationOutbox1789890000000',
        'EnforceBillingDecisionNotificationTerminalState1789891000000',
      ]);
      await expectCompleteAdditiveSchema(fresh, schema);
    } finally {
      if (fresh.isInitialized) await fresh.destroy();
      liveSources.delete(fresh);
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('upgrades the original ledger/schema, preserving its row and adding every object', async () => {
    await withOriginalSchema(async (original, schema) => {
      const ids = await seedOriginalRow(original);
      const upgraded = await upgrade(original, schema);
      await expectCompleteAdditiveSchema(upgraded, schema);
      expect(await originalRow(upgraded, ids.outboxId)).toMatchObject({
        id: ids.outboxId,
        notes: 'preserve-original-history',
      });
      expect(await migrationNames(upgraded)).toEqual([
        'CreateBillingDecisionNotificationOutbox1789890000000',
        'EnforceBillingDecisionNotificationTerminalState1789891000000',
      ]);
    });
  });

  it('supports fresh forward-revert-forward while retaining original baseline data', async () => {
    await withOriginalSchema(async (original, schema) => {
      const ids = await seedOriginalRow(original);
      const upgraded = await upgrade(original, schema);
      await upgraded.undoLastMigration();
      expect(await columnNames(upgraded, schema)).not.toEqual(expect.arrayContaining(NEW_COLUMNS));
      expect(await originalRow(upgraded, ids.outboxId)).toMatchObject({ id: ids.outboxId });
      const reapplied = await upgraded.runMigrations();
      expect(reapplied.map((migration) => migration.name)).toEqual([
        'EnforceBillingDecisionNotificationTerminalState1789891000000',
      ]);
      await expectCompleteAdditiveSchema(upgraded, schema);
    });
  });

  it('holds the rollback lock through DROP COLUMN so a concurrent evidence write cannot commit in the gap', async () => {
    await withOriginalSchema(async (original, schema) => {
      const ids = await seedOriginalRow(original);
      const upgraded = await upgrade(original, schema);
      const rollbackRunner = upgraded.createQueryRunner();
      const writerRunner = upgraded.createQueryRunner();
      await rollbackRunner.connect();
      await writerRunner.connect();
      await rollbackRunner.startTransaction();
      const [{ pg_backend_pid: writerPid }] = await writerRunner.query(
        'SELECT pg_backend_pid()::int AS pg_backend_pid',
      );
      let writerSettled = false;
      let writerResult: Promise<{ error?: { code?: string } }> | undefined;
      const wrapped = new Proxy(rollbackRunner, {
        get(target, property) {
          if (property !== 'query') return Reflect.get(target, property, target);
          return async (sql: string, parameters?: unknown[]) => {
            const result = await target.query(sql, parameters);
            if (/LOCK TABLE.*ACCESS EXCLUSIVE MODE/s.test(sql)) {
              writerResult = writerRunner
                .query(
                  `UPDATE "billing_decision_notification_outbox"
                      SET "provider_request_body" = $2, "first_send_attempted_at" = now()
                    WHERE "id" = $1`,
                  [ids.outboxId, 'durable-evidence-racing-rollback'],
                )
                .then(
                  () => ({}),
                  (error: { code?: string }) => ({ error }),
                )
                .finally(() => {
                  writerSettled = true;
                });
              await waitForWriterLock(bootstrap, writerPid);
              expect(writerSettled).toBe(false);
            }
            return result;
          };
        },
      });

      try {
        await new ADDITIVE().down(wrapped);
        expect(writerSettled).toBe(false);
        await rollbackRunner.commitTransaction();
        const outcome = await writerResult!;
        expect(outcome.error?.code).toBe('42703');
        expect(await columnNames(upgraded, schema)).not.toEqual(
          expect.arrayContaining(NEW_COLUMNS),
        );
      } finally {
        if (rollbackRunner.isTransactionActive) await rollbackRunner.rollbackTransaction();
        await rollbackRunner.release();
        await writerRunner.release();
      }
    });
  });

  it('accepts an intermediate schema and preserves an existing immutable payload', async () => {
    await withOriginalSchema(async (original, schema) => {
      const ids = await seedOriginalRow(original);
      await original.query(`
        ALTER TABLE "billing_decision_notification_outbox"
          ADD COLUMN "first_send_attempted_at" timestamptz NULL,
          ADD COLUMN "provider_request_body" text NULL
      `);
      const payload = JSON.stringify({
        from: 'Billing <sender@example.invalid>',
        to: ['owner@example.invalid'],
        subject: 'Immutable',
        text: 'Preserve these exact bytes.',
      });
      await original.query(
        `UPDATE "billing_decision_notification_outbox"
            SET "first_send_attempted_at" = now(), "provider_request_body" = $2
          WHERE "id" = $1`,
        [ids.outboxId, payload],
      );
      const upgraded = await upgrade(original, schema);
      await expectCompleteAdditiveSchema(upgraded, schema);
      const [row] = await upgraded.query(
        `SELECT "provider_request_body" FROM "billing_decision_notification_outbox" WHERE "id" = $1`,
        [ids.outboxId],
      );
      expect(row.provider_request_body).toBe(payload);
      await expect(upgraded.undoLastMigration()).rejects.toThrow(
        /refusing to remove T070 delivery columns containing durable evidence/,
      );
      const [preserved] = await upgraded.query(
        `SELECT "provider_request_body" FROM "billing_decision_notification_outbox" WHERE "id" = $1`,
        [ids.outboxId],
      );
      expect(preserved.provider_request_body).toBe(payload);
      expect(await columnNames(upgraded, schema)).toEqual(expect.arrayContaining(NEW_COLUMNS));
    });
  });

  it('reconciles contradictory intermediate terminal evidence before adding the CHECK', async () => {
    await withOriginalSchema(async (original, schema) => {
      const ids = await seedOriginalRow(original);
      await original.query(`
        ALTER TABLE "billing_decision_notification_outbox"
          ADD COLUMN "provider_message_id" text NULL,
          ADD COLUMN "quarantined_at" timestamptz NULL,
          ADD COLUMN "delivery_rejected_at" timestamptz NULL
      `);
      await original.query(
        `UPDATE "billing_decision_notification_outbox"
            SET "delivered_at" = now(), "provider_message_id" = 'provider-accepted',
                "delivery_rejected_at" = now(), "quarantined_at" = now()
          WHERE "id" = $1`,
        [ids.outboxId],
      );
      const upgraded = await upgrade(original, schema);
      const [row] = await upgraded.query(
        `SELECT "delivered_at", "provider_message_id", "delivery_rejected_at", "quarantined_at"
           FROM "billing_decision_notification_outbox" WHERE "id" = $1`,
        [ids.outboxId],
      );
      expect(row.delivered_at).not.toBeNull();
      expect(row.provider_message_id).toBe('provider-accepted');
      expect(row.delivery_rejected_at).toBeNull();
      expect(row.quarantined_at).toBeNull();
      await expect(
        upgraded.query(
          `UPDATE "billing_decision_notification_outbox"
              SET "delivery_rejected_at" = now(), "quarantined_at" = now()
            WHERE "id" = $1`,
          [ids.outboxId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});

async function seedOriginalRow(source: DataSource) {
  const tenantId = randomUUID();
  const submissionId = randomUUID();
  const outboxId = randomUUID();
  await source.query('INSERT INTO "tenant" ("id") VALUES ($1)', [tenantId]);
  await source.query('INSERT INTO "payment_submission" ("id") VALUES ($1)', [submissionId]);
  await source.query(
    `INSERT INTO "billing_decision_notification_outbox"
       ("id", "submission_id", "tenant_id", "decision", "decision_occurrence", "notes",
        "occurred_at", "job_id")
     VALUES ($1, $2, $3, 'reject', 1, 'preserve-original-history', now(), $4)`,
    [outboxId, submissionId, tenantId, `${submissionId}.reject.1`],
  );
  return { outboxId };
}

async function migrationNames(source: DataSource): Promise<string[]> {
  const rows = (await source.query(
    'SELECT "name" FROM "migrations" ORDER BY "timestamp"',
  )) as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

async function columnNames(source: DataSource, schema: string): Promise<string[]> {
  const rows = (await source.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'billing_decision_notification_outbox'`,
    [schema],
  )) as Array<{ column_name: string }>;
  return rows.map((row) => row.column_name);
}

async function expectCompleteAdditiveSchema(source: DataSource, schema: string): Promise<void> {
  expect(await columnNames(source, schema)).toEqual(expect.arrayContaining(NEW_COLUMNS));
  const indexes = await source.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1
      AND indexname = 'ix_billing_decision_notification_outbox_ambiguous_sweep'`,
    [schema],
  );
  expect(indexes).toHaveLength(1);
  const constraints = await source.query(
    `SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = $1 AND c.conname = 'ck_billing_decision_notification_outbox_terminal_state'`,
    [schema],
  );
  expect(constraints).toHaveLength(1);
}

async function originalRow(source: DataSource, id: string): Promise<Record<string, unknown>> {
  const [row] = await source.query(
    `SELECT "id", "notes" FROM "billing_decision_notification_outbox" WHERE "id" = $1`,
    [id],
  );
  return row;
}

async function waitForWriterLock(source: DataSource, writerPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [activity] = await source.query(
      `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
      [writerPid],
    );
    if (activity?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('concurrent evidence writer did not block on the rollback table lock');
}
