import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { DataSource, QueryRunner } from 'typeorm';
import { assertAuditSourceLinked, AuditLinkQuery } from './audit-source-linkage';

type Query = QueryRunner['query'];
type FixtureId =
  | 'dedupe-test'
  | 'dedupe-orphan-tenant'
  | 'dedupe-orphan-tenant-second'
  | 'dedupe-entity-test'
  | 'migration-pretenant-account'
  | 'migration-runtime-role-account'
  | 'migration-update-orphan'
  | 'migration-delete-orphan'
  | 'support-denial-grant-required'
  | 'support-denial-invalid-grant'
  | 'support-denial-unknown-grant';

export interface T093ExpectedNonLinkableDenial {
  action: 'support_access.grant.denied';
  subjectType: 'support_access_grant';
  subjectId: string;
  tenantId: string;
  payload: { denial_reason: 'grant_required' | 'invalid_grant' | 'unknown_grant' };
}

interface Fixture {
  expectedFailure: RegExp;
  expectedNonLinkableDenial?: boolean;
  acceptedSourceReadFailure?: {
    action: string;
    subjectType: string;
    subjectId: string;
    tenantId: null;
    error: string;
  };
}

export const T093_NEGATIVE_FIXTURES: Readonly<Record<FixtureId, Fixture>> = {
  'dedupe-test': { expectedFailure: /unrecognized/ },
  'dedupe-orphan-tenant': { expectedFailure: /missing|wrong tenant/ },
  'dedupe-orphan-tenant-second': { expectedFailure: /missing|wrong tenant/ },
  'dedupe-entity-test': { expectedFailure: /unrecognized/ },
  'migration-pretenant-account': { expectedFailure: /missing|wrong tenant/ },
  'migration-runtime-role-account': {
    expectedFailure: /missing|wrong tenant/,
    acceptedSourceReadFailure: {
      action: 'account.created',
      subjectType: 'account',
      subjectId: '99999999-9999-9999-9999-999999999999',
      tenantId: null,
      error: 'permission denied for table account',
    },
  },
  'migration-update-orphan': { expectedFailure: /missing|wrong tenant/ },
  'migration-delete-orphan': { expectedFailure: /missing|wrong tenant/ },
  'support-denial-grant-required': {
    expectedFailure: /missing|wrong tenant/,
    expectedNonLinkableDenial: true,
  },
  'support-denial-invalid-grant': {
    expectedFailure: /missing|wrong tenant/,
    expectedNonLinkableDenial: true,
  },
  'support-denial-unknown-grant': {
    expectedFailure: /missing|wrong tenant/,
    expectedNonLinkableDenial: true,
  },
};

const context = new AsyncLocalStorage<{
  internal?: boolean;
  fixtureId?: FixtureId;
  expectedNonLinkableDenial?: T093ExpectedNonLinkableDenial;
}>();
const originalCreateQueryRunner = DataSource.prototype.createQueryRunner;
const auditInsert = /^\s*INSERT\s+INTO\s+["']?audit_event\b/i;
const transactionCompleted = /^\s*(?:COMMIT|END)\b/i;

export function isT093AcceptedSourceReadFailure(
  fixtureId: string,
  row: { action: string; subject_type: string; subject_id: string; tenant_id: string | null },
  failure: Error,
): boolean {
  const fixture = T093_NEGATIVE_FIXTURES[fixtureId as FixtureId];
  const accepted = fixture?.acceptedSourceReadFailure;
  return Boolean(
    accepted &&
    row.action === accepted.action &&
    row.subject_type === accepted.subjectType &&
    row.subject_id === accepted.subjectId &&
    row.tenant_id === accepted.tenantId &&
    failure.message === accepted.error,
  );
}

export function withT093NegativeFixture<T>(
  fixtureId: FixtureId,
  expectedOrWork: T093ExpectedNonLinkableDenial | (() => Promise<T>),
  dynamicWork?: () => Promise<T>,
): Promise<T> {
  const expectedNonLinkableDenial =
    typeof expectedOrWork === 'function' ? undefined : expectedOrWork;
  const work = typeof expectedOrWork === 'function' ? expectedOrWork : dynamicWork;
  if (!work) throw new Error(`T093 negative fixture ${fixtureId} has no work callback`);
  return context.run({ fixtureId, expectedNonLinkableDenial }, work);
}

export function isT093ExpectedNonLinkableDenial(
  fixtureId: string,
  row: {
    action: string;
    subject_type: string;
    subject_id: string;
    tenant_id: string | null;
    payload: Record<string, unknown>;
  },
  failure: Error,
  expected: T093ExpectedNonLinkableDenial | undefined,
): boolean {
  const fixture = T093_NEGATIVE_FIXTURES[fixtureId as FixtureId];
  if (!fixture?.expectedNonLinkableDenial || !expected) return false;
  return (
    row.action === expected.action &&
    row.subject_type === expected.subjectType &&
    row.subject_id === expected.subjectId &&
    row.tenant_id === expected.tenantId &&
    isDeepStrictEqual(row.payload, expected.payload) &&
    failure.message ===
      `audit subject is missing or belongs to the wrong tenant: ${expected.subjectType}/${expected.subjectId}`
  );
}

async function ensureObserver(query: Query): Promise<boolean> {
  const state = await query(
    `SELECT to_regclass('public.audit_event') AS audit,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.audit_event')
         AND tgname='t093_capture_audit_trigger' AND NOT tgisinternal) AS trigger`,
  );
  if (!state[0]?.audit) return false;
  if (state[0].trigger) return true;

  await query(`CREATE TABLE IF NOT EXISTS public.t093_audit_capture (
    capture_id bigserial PRIMARY KEY, event_id uuid UNIQUE NOT NULL, tenant_id uuid,
    action text NOT NULL, subject_type text NOT NULL, subject_id text NOT NULL,
    payload jsonb NOT NULL, suite_path text NOT NULL, test_name text NOT NULL,
    write_token uuid NOT NULL,
    fixture_id text, validation_outcome text, diagnostic text)`);
  await query(`CREATE OR REPLACE FUNCTION public.t093_capture_audit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN
      INSERT INTO public.t093_audit_capture(event_id,tenant_id,action,subject_type,subject_id,payload,
        suite_path,test_name,write_token,fixture_id)
      VALUES(NEW.id,NEW.tenant_id,NEW.action,NEW.subject_type,NEW.subject_id::text,NEW.payload,
        COALESCE(current_setting('t093.suite',true),'unknown'),
        COALESCE(current_setting('t093.test',true),'unknown'),
        current_setting('t093.write_token')::uuid,
        NULLIF(current_setting('t093.fixture',true),''))
      ON CONFLICT(event_id) DO NOTHING;
      RETURN NEW;
    END $$`);
  await query(`ALTER FUNCTION public.t093_capture_audit() OWNER TO CURRENT_USER`);
  await query(`REVOKE ALL ON FUNCTION public.t093_capture_audit() FROM PUBLIC`);
  await query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kemfai_api') THEN
      GRANT SELECT ON TABLE public.t093_audit_capture TO kemfai_api;
      GRANT UPDATE (validation_outcome, diagnostic) ON TABLE public.t093_audit_capture TO kemfai_api;
    END IF;
  END $$`);
  await query(`CREATE TRIGGER t093_capture_audit_trigger AFTER INSERT ON public.audit_event
    FOR EACH ROW EXECUTE FUNCTION public.t093_capture_audit()`);
  return true;
}

async function validateCapture(
  connection: AuditLinkQuery,
  query: Query,
  writeToken: string,
): Promise<void> {
  const rows = await query(
    `SELECT * FROM public.t093_audit_capture
     WHERE write_token=$1 AND validation_outcome IS NULL ORDER BY capture_id`,
    [writeToken],
  );
  if (!rows.length) throw new Error(`T093 audit insert ${writeToken} produced no capture`);
  for (const row of rows) {
    let failure: Error | undefined;
    try {
      await assertAuditSourceLinked(connection, {
        action: row.action,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        tenantId: row.tenant_id,
        payload: row.payload,
      });
    } catch (error) {
      failure = error as Error;
    }
    const fixture = row.fixture_id
      ? T093_NEGATIVE_FIXTURES[row.fixture_id as FixtureId]
      : undefined;
    if (fixture) {
      const expectedNonLinkableDenial = context.getStore()?.expectedNonLinkableDenial;
      if (fixture.expectedNonLinkableDenial) {
        if (
          !failure ||
          !isT093ExpectedNonLinkableDenial(row.fixture_id, row, failure, expectedNonLinkableDenial)
        ) {
          throw new Error(
            `T093 negative fixture ${row.fixture_id} did not match its exact non-linkable denial shape`,
          );
        }
        await query(
          `UPDATE public.t093_audit_capture SET validation_outcome='expected-negative', diagnostic=$2
           WHERE capture_id=$1`,
          [row.capture_id, failure.message],
        );
        continue;
      }
      const acceptedSourceReadFailure =
        failure && isT093AcceptedSourceReadFailure(row.fixture_id, row, failure);
      if (
        !failure ||
        (!acceptedSourceReadFailure && !fixture.expectedFailure.test(failure.message))
      ) {
        throw new Error(
          `T093 negative fixture ${row.fixture_id} unexpectedly ${failure ? `failed: ${failure.message}` : 'resolved'}`,
        );
      }
      await query(
        `UPDATE public.t093_audit_capture SET validation_outcome='expected-negative', diagnostic=$2
         WHERE capture_id=$1`,
        [row.capture_id, failure.message],
      );
    } else if (failure) {
      throw new Error(`T093 unclassified audit event ${row.event_id}: ${failure.message}`);
    } else {
      await query(
        `UPDATE public.t093_audit_capture SET validation_outcome='linked',
           diagnostic='resolved on writing connection before cleanup' WHERE capture_id=$1`,
        [row.capture_id],
      );
    }
  }
}

DataSource.prototype.createQueryRunner = function (mode?: 'master' | 'slave'): QueryRunner {
  const runner = originalCreateQueryRunner.call(this, mode);
  const originalQuery = runner.query.bind(runner);
  runner.query = createT093ObservedQuery(runner, originalQuery);
  return runner;
};

export function createT093ObservedQuery(runner: QueryRunner, originalQuery: Query): Query {
  return (async (sql: string, parameters?: any[], useStructuredResult?: boolean) => {
    const execute = () =>
      useStructuredResult === true
        ? originalQuery(sql, parameters, true)
        : originalQuery(sql, parameters);
    if (context.getStore()?.internal) return execute();

    return context.run({ ...context.getStore(), internal: true }, async () => {
      // Never probe/install from within a transaction: the subject may already have
      // aborted it, and setup DDL must not become part of application transactions.
      // A migration or test may replace audit_event, which also removes its trigger. Recheck
      // immediately before every observable insert whenever DDL is safe.
      let observerAvailable = false;
      if (!runner.isTransactionActive) {
        observerAvailable = await ensureObserver(originalQuery);
      }

      if (!auditInsert.test(sql)) {
        const result = await execute();
        // TypeORM keeps isTransactionActive=true until its COMMIT query returns. Reinstall only
        // after that successful boundary; a rejected COMMIT/aborted transaction installs nothing.
        if (transactionCompleted.test(sql)) await ensureObserver(originalQuery);
        return result;
      }

      if (!observerAvailable && !runner.isTransactionActive) {
        throw new Error('T093 observer could not attach to public.audit_event');
      }

      const state = expect.getState();
      const writeToken = randomUUID();
      await originalQuery(
        `SELECT set_config('t093.suite',$1,$5), set_config('t093.test',$2,$5),
           set_config('t093.fixture',$3,$5), set_config('t093.write_token',$4,$5)`,
        [
          state.testPath ?? 'unknown',
          state.currentTestName ?? 'hook',
          context.getStore()?.fixtureId ?? '',
          writeToken,
          runner.isTransactionActive,
        ],
      );

      // Deliberately no finally/post-failure query. A rejected INSERT may leave its
      // transaction in 25P02; rollback must be the very next database operation.
      const result = await execute();
      // TypeORM requests a structured QueryResult for QueryBuilder INSERTs. An idempotent
      // ON CONFLICT DO NOTHING reports affected=0 and persisted no audit write to validate.
      if (
        useStructuredResult === true &&
        typeof result === 'object' &&
        result !== null &&
        'affected' in result &&
        result.affected === 0
      ) {
        if (!runner.isTransactionActive) {
          await originalQuery(
            `SELECT set_config('t093.suite','',false), set_config('t093.test','',false),
               set_config('t093.fixture','',false), set_config('t093.write_token','',false)`,
          );
        }
        return result;
      }
      await validateCapture({ query: originalQuery }, originalQuery, writeToken);
      if (!runner.isTransactionActive) {
        await originalQuery(
          `SELECT set_config('t093.suite','',false), set_config('t093.test','',false),
             set_config('t093.fixture','',false), set_config('t093.write_token','',false)`,
        );
      }
      return result;
    });
  }) as Query;
}
