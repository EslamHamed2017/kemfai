import { QueryRunner } from 'typeorm';
import {
  createT093ObservedQuery,
  isT093AcceptedSourceReadFailure,
  isT093ExpectedNonLinkableDenial,
  T093ExpectedNonLinkableDenial,
  withT093NegativeFixture,
} from './t093-observer';

describe('T093 exact non-linkable support denial fixtures', () => {
  const tenantId = '10000000-0000-4000-8000-000000000001';
  const sentinel = '00000000-0000-4000-8000-000000000000';
  const unknown = '10000000-0000-4000-8000-000000000002';

  const cases = [
    ['support-denial-grant-required', 'grant_required', sentinel],
    ['support-denial-invalid-grant', 'invalid_grant', sentinel],
    ['support-denial-unknown-grant', 'unknown_grant', unknown],
  ] as const;

  function expected(reason: (typeof cases)[number][1], subjectId: string) {
    return {
      action: 'support_access.grant.denied',
      subjectType: 'support_access_grant',
      subjectId,
      tenantId,
      payload: { denial_reason: reason },
    } satisfies T093ExpectedNonLinkableDenial;
  }

  function captured(shape: T093ExpectedNonLinkableDenial) {
    return {
      action: shape.action,
      subject_type: shape.subjectType,
      subject_id: shape.subjectId,
      tenant_id: shape.tenantId,
      payload: shape.payload,
    };
  }

  it.each(cases)('accepts the exact %s shape', (fixtureId, reason, subjectId) => {
    const shape = expected(reason, subjectId);
    const error = new Error(
      `audit subject is missing or belongs to the wrong tenant: support_access_grant/${subjectId}`,
    );
    expect(isT093ExpectedNonLinkableDenial(fixtureId, captured(shape), error, shape)).toBe(true);
  });

  it.each([
    ['action', { action: 'support_access.grant.used' }],
    ['subject type', { subject_type: 'tenant' }],
    ['subject ID', { subject_id: unknown }],
    ['tenant', { tenant_id: unknown }],
    ['payload', { payload: { denial_reason: 'unknown_grant' } }],
  ])('rejects a mismatched %s', (_label, mismatch) => {
    const shape = expected('grant_required', sentinel);
    const error = new Error(
      `audit subject is missing or belongs to the wrong tenant: support_access_grant/${sentinel}`,
    );
    expect(
      isT093ExpectedNonLinkableDenial(
        'support-denial-grant-required',
        { ...captured(shape), ...mismatch },
        error,
        shape,
      ),
    ).toBe(false);
  });

  it.each([
    ['wrong resolver class', new Error('permission denied for table support_access_grant')],
    [
      'wrong resolver subject',
      new Error(`audit subject is missing or belongs to the wrong tenant: tenant/${sentinel}`),
    ],
  ])('rejects a mismatched %s error', (_label, error) => {
    const shape = expected('grant_required', sentinel);
    expect(
      isT093ExpectedNonLinkableDenial(
        'support-denial-grant-required',
        captured(shape),
        error,
        shape,
      ),
    ).toBe(false);
  });
});

describe('T093 exact source-read exception', () => {
  const exactRow = {
    action: 'account.created',
    subject_type: 'account',
    subject_id: '99999999-9999-9999-9999-999999999999',
    tenant_id: null,
  };
  const exactError = new Error('permission denied for table account');

  it('accepts only the declared runtime-role account fixture shape', () => {
    expect(
      isT093AcceptedSourceReadFailure('migration-runtime-role-account', exactRow, exactError),
    ).toBe(true);
  });

  it.each([
    ['action', { ...exactRow, action: 'account.updated' }, exactError],
    ['id', { ...exactRow, subject_id: '99999999-9999-9999-9999-999999999998' }, exactError],
    ['tenant', { ...exactRow, tenant_id: '99999999-9999-9999-9999-999999999999' }, exactError],
    ['error', exactRow, new Error('permission denied for table account ')],
  ])('rejects a mismatched %s', (_field, row, error) => {
    expect(isT093AcceptedSourceReadFailure('migration-runtime-role-account', row, error)).toBe(
      false,
    );
  });
});

describe('T093 transaction-safe observer', () => {
  function runner(inTransaction = false): QueryRunner {
    return { isTransactionActive: inTransaction } as QueryRunner;
  }

  it('validates only the capture belonging to a successful insert and not later queries', async () => {
    const calls: string[] = [];
    const query = jest.fn(async (sql: string, parameters?: unknown[]) => {
      calls.push(sql);
      if (sql.includes("to_regclass('public.audit_event')")) {
        return [{ audit: 'audit_event', trigger: true }];
      }
      if (sql.includes('WHERE write_token=$1')) {
        return [
          {
            capture_id: '1',
            event_id: '10000000-0000-4000-8000-000000000001',
            tenant_id: null,
            action: 'test.action',
            subject_type: 'test',
            subject_id: '10000000-0000-4000-8000-000000000002',
            payload: {},
            fixture_id: 'dedupe-test',
            validation_outcome: null,
            write_token: parameters?.[0],
          },
        ];
      }
      return [];
    });
    const observed = createT093ObservedQuery(runner(), query as unknown as QueryRunner['query']);

    await withT093NegativeFixture('dedupe-test', () =>
      observed(
        `INSERT INTO audit_event(actor_type,action,subject_type,subject_id,payload)
         VALUES('system','test.action','test','10000000-0000-4000-8000-000000000002','{}')`,
      ),
    );
    await observed('SELECT 1');

    expect(calls.filter((sql) => sql.includes('WHERE write_token=$1'))).toHaveLength(1);
    expect(
      calls.filter((sql) => sql.includes("validation_outcome='expected-negative'")),
    ).toHaveLength(1);
    expect(calls.filter((sql) => sql === 'SELECT 1')).toHaveLength(1);
  });

  it('runs no observer SQL after a failed insert, leaving rollback as the next operation', async () => {
    const mockRunner = runner(true);
    const calls: string[] = [];
    const query = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (/^INSERT INTO audit_event/.test(sql)) throw new Error('duplicate key value');
      return [];
    });
    const observed = createT093ObservedQuery(mockRunner, query as unknown as QueryRunner['query']);

    await expect(observed('INSERT INTO audit_event VALUES (...)')).rejects.toThrow(/duplicate/);
    await observed('ROLLBACK');

    const failedInsert = calls.findIndex((sql) => /^INSERT INTO audit_event/.test(sql));
    expect(calls.slice(failedInsert)).toEqual(['INSERT INTO audit_event VALUES (...)', 'ROLLBACK']);
    expect(calls.some((sql) => sql.includes('WHERE write_token=$1'))).toBe(false);
  });

  it('does not demand a capture for an idempotent insert that persisted no row', async () => {
    const calls: string[] = [];
    const query = jest.fn(async (sql: string, _parameters?: unknown[], structured?: boolean) => {
      calls.push(sql);
      if (sql.includes("to_regclass('public.audit_event')")) {
        return [{ audit: 'audit_event', trigger: true }];
      }
      if (/^INSERT INTO audit_event/.test(sql) && structured) return { affected: 0, records: [] };
      return [];
    });
    const observed = createT093ObservedQuery(runner(), query as unknown as QueryRunner['query']);

    await expect(observed('INSERT INTO audit_event VALUES (...)', [], true)).resolves.toMatchObject(
      {
        affected: 0,
      },
    );
    expect(calls.some((sql) => sql.includes('WHERE write_token=$1'))).toBe(false);
  });

  it('installs a hardened definer trigger that a restricted runtime insert can invoke', async () => {
    const calls: string[] = [];
    const query = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("to_regclass('public.audit_event')")) {
        return [{ audit: 'audit_event', trigger: false }];
      }
      return [];
    });
    const observed = createT093ObservedQuery(runner(), query as unknown as QueryRunner['query']);

    await observed('SELECT 1');

    const functionDdl = calls.find((sql) => sql.includes('CREATE OR REPLACE FUNCTION'));
    expect(functionDdl).toContain('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');
    expect(functionDdl).toContain('INSERT INTO public.t093_audit_capture');
    expect(calls).toContain('ALTER FUNCTION public.t093_capture_audit() OWNER TO CURRENT_USER');
    expect(calls).toContain('REVOKE ALL ON FUNCTION public.t093_capture_audit() FROM PUBLIC');
    expect(calls.some((sql) => sql.includes('GRANT UPDATE (validation_outcome, diagnostic)'))).toBe(
      true,
    );
    expect(calls.some((sql) => sql.includes('AFTER INSERT ON public.audit_event'))).toBe(true);
  });

  it('reinstalls only after a successful migration commit replaces audit_event', async () => {
    const mockRunner = runner(true);
    const calls: string[] = [];
    const query = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("to_regclass('public.audit_event')")) {
        return [{ audit: 'audit_event', trigger: false }];
      }
      return [];
    });
    const observed = createT093ObservedQuery(mockRunner, query as unknown as QueryRunner['query']);

    await observed('COMMIT');

    expect(calls[0]).toBe('COMMIT');
    expect(calls.findIndex((sql) => sql.includes('CREATE TRIGGER'))).toBeGreaterThan(0);
  });

  it('does not reinstall when a migration commit fails', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql === 'COMMIT') throw new Error('transaction aborted');
      return [];
    });
    const observed = createT093ObservedQuery(
      runner(true),
      query as unknown as QueryRunner['query'],
    );

    await expect(observed('COMMIT')).rejects.toThrow(/aborted/);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
