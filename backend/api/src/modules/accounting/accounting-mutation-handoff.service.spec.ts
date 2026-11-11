import { ConflictException } from '@nestjs/common';
import controlDataSource from '../../database/data-source';
const AccountingMutationHandoffState = {
  PENDING: 'pending',
  ODOO_COMMITTED: 'odoo_committed',
  AUDITED: 'audited',
} as const;

type HandoffRow = {
  id: string;
  state: string;
  retryCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  requestFingerprint: string;
  finalResponse: unknown;
};

type HandoffServiceContract = {
  findOrCreateHandoff(input: Record<string, unknown>): Promise<HandoffRow>;
  findById(id: string): Promise<HandoffRow>;
  markOdooCommitted(id: string, response: unknown): Promise<void>;
  markRejected(id: string, errorCode: string): Promise<void>;
  markAudited(id: string): Promise<void>;
  claimBatchForRecovery(owner: string, durationMs: number, size: number): Promise<HandoffRow[]>;
};

const TENANT_ID = '24242424-1111-4111-8111-111111111111';
const ACCOUNT_ID = '24242424-2222-4222-8222-222222222222';
const COMPANY_ID = '24242424-3333-4333-8333-333333333333';

function input(overrides: Record<string, unknown> = {}) {
  return {
    action: 'account.create',
    tenantId: TENANT_ID,
    companyUuid: COMPANY_ID,
    actorAccountId: ACCOUNT_ID,
    principalIdentity: 'keycloak-t024-user',
    odooDbName: 'kemfai_t024_tenant_a',
    odooCompanyId: 101,
    requestFingerprint: 'sha256:request-a',
    requestPayload: { code: '1000', nameEn: 'Cash', nameAr: 'النقدية' },
    idempotencyKey: 't024-key',
    callerScope: `${ACCOUNT_ID}:${TENANT_ID}`,
    method: 'POST',
    route: '/accounting/accounts',
    ...overrides,
  };
}

describe('AccountingMutationHandoffService (real control DB)', () => {
  let service: HandoffServiceContract;

  beforeAll(async () => {
    const implementationPath = './accounting-' + 'mutation-handoff.service';
    const implementation = jest.requireActual<Record<string, unknown>>(implementationPath);
    const Service =
      implementation.AccountingMutationHandoffService as new () => HandoffServiceContract;
    service = new Service();
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();
  });

  beforeEach(async () => {
    await controlDataSource.query('DELETE FROM "accounting_mutation_handoff"');
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) {
      await controlDataSource.query('DELETE FROM "accounting_mutation_handoff"');
      await controlDataSource.destroy();
    }
  });

  it('migration exposes pending state and bounded lease/backoff fields', async () => {
    const columns = await controlDataSource.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'accounting_mutation_handoff'`,
    );
    const names = new Set(columns.map((row: { column_name: string }) => row.column_name));
    for (const required of [
      'id',
      'state',
      'retry_count',
      'next_attempt_at',
      'lease_owner',
      'lease_expires_at',
      'request_fingerprint',
      'final_response',
    ]) {
      expect(names.has(required)).toBe(true);
    }
    const row = await service.findOrCreateHandoff(input());
    expect(row).toMatchObject({
      state: AccountingMutationHandoffState.PENDING,
      retryCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it('persists pending -> odoo_committed -> audited without changing operation UUID', async () => {
    const pending = await service.findOrCreateHandoff(input());
    const response = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1 };
    await service.markOdooCommitted(pending.id, response);
    const committed = await service.findById(pending.id);
    expect(committed).toMatchObject({
      id: pending.id,
      state: AccountingMutationHandoffState.ODOO_COMMITTED,
      finalResponse: response,
    });
    await service.markAudited(pending.id);
    expect(await service.findById(pending.id)).toMatchObject({
      id: pending.id,
      state: AccountingMutationHandoffState.AUDITED,
      finalResponse: response,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it('terminally rejects deterministic faults and excludes them from recovery claims', async () => {
    const pending = await service.findOrCreateHandoff(input({ idempotencyKey: 'terminal-reject' }));
    await service.markRejected(pending.id, 'STALE_VERSION');

    expect(await service.findById(pending.id)).toMatchObject({
      state: 'rejected',
      lastErrorCode: 'STALE_VERSION',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(await service.claimBatchForRecovery('worker-terminal', 5_000, 10)).toEqual([]);
  });

  it('two concurrent requests for the same scoped key own exactly one row', async () => {
    const [first, second] = await Promise.all([
      service.findOrCreateHandoff(input()),
      service.findOrCreateHandoff(input()),
    ]);
    expect(first.id).toBe(second.id);
    expect(
      await controlDataSource.query(
        'SELECT id FROM "accounting_mutation_handoff" WHERE idempotency_key = $1',
        ['t024-key'],
      ),
    ).toHaveLength(1);
  });

  it('same scoped key with another fingerprint conflicts and preserves the original row', async () => {
    const original = await service.findOrCreateHandoff(input());
    await expect(
      service.findOrCreateHandoff(input({ requestFingerprint: 'sha256:request-b' })),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await service.findById(original.id)).toMatchObject({
      requestFingerprint: 'sha256:request-a',
      state: AccountingMutationHandoffState.PENDING,
    });
  });

  it('concurrent recovery claims are disjoint and populate bounded lease fields', async () => {
    await Promise.all([
      service.findOrCreateHandoff(input({ idempotencyKey: 'lease-a' })),
      service.findOrCreateHandoff(input({ idempotencyKey: 'lease-b' })),
    ]);
    const [workerA, workerB] = await Promise.all([
      service.claimBatchForRecovery('worker-a', 5_000, 1),
      service.claimBatchForRecovery('worker-b', 5_000, 1),
    ]);
    expect(workerA).toHaveLength(1);
    expect(workerB).toHaveLength(1);
    expect(workerA[0].id).not.toBe(workerB[0].id);
    for (const [worker, owner] of [
      [workerA[0], 'worker-a'],
      [workerB[0], 'worker-b'],
    ] as const) {
      expect(worker.leaseOwner).toBe(owner);
      expect(worker.leaseExpiresAt).toBeInstanceOf(Date);
      expect(worker.retryCount).toBe(1);
    }
  });
});
