import type { QueryRunner } from 'typeorm';
import { EnforceBillingDecisionNotificationTerminalState1789891000000 } from './migrations/1789891000000-EnforceBillingDecisionNotificationTerminalState';

describe('EnforceBillingDecisionNotificationTerminalState1789891000000 SQL ordering', () => {
  const migration = new EnforceBillingDecisionNotificationTerminalState1789891000000();
  let query: jest.Mock;
  let runner: QueryRunner;

  function mockRunner(isTransactionActive: boolean): QueryRunner {
    return {
      query,
      isTransactionActive,
      startTransaction: jest.fn(async function (this: QueryRunner) {
        Object.defineProperty(this, 'isTransactionActive', { value: true, writable: true });
      }),
      commitTransaction: jest.fn(async function (this: QueryRunner) {
        Object.defineProperty(this, 'isTransactionActive', { value: false, writable: true });
      }),
      rollbackTransaction: jest.fn(async function (this: QueryRunner) {
        Object.defineProperty(this, 'isTransactionActive', { value: false, writable: true });
      }),
    } as unknown as QueryRunner;
  }

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    runner = mockRunner(false);
  });

  it('creates all missing schema objects before reconciliation and the CHECK', async () => {
    await migration.up(runner);
    expect(query).toHaveBeenCalledTimes(5);
    const sql = query.mock.calls.map(([statement]) => statement as string);
    for (const column of [
      'decision_occurrence',
      'delivered_at',
      'first_send_attempted_at',
      'provider_request_body',
      'provider_message_id',
      'quarantined_at',
      'delivery_rejected_at',
    ]) {
      expect(sql[0]).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`));
    }
    expect(sql[1]).toMatch(/ALTER COLUMN "decision_occurrence" DROP DEFAULT/);
    expect(sql[2]).toMatch(/CREATE INDEX IF NOT EXISTS.*ambiguous_sweep/s);
    expect(sql[3]).toMatch(/UPDATE "billing_decision_notification_outbox"/);
    expect(sql[4]).toMatch(/ADD CONSTRAINT.*terminal_state/s);
  });

  it('owns a transaction for direct invocation and holds ACCESS EXCLUSIVE before guard and DDL', async () => {
    await migration.down(runner);
    expect(runner.startTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    const sql = query.mock.calls.map(([statement]) => statement as string);
    expect(sql[0]).toMatch(/LOCK TABLE.*ACCESS EXCLUSIVE MODE/s);
    expect(sql[1]).toMatch(/refusing to remove T070 delivery columns containing durable evidence/);
    expect(sql[2]).toMatch(/DROP CONSTRAINT IF EXISTS.*terminal_state/s);
    expect(sql[3]).toMatch(/DROP INDEX IF EXISTS.*ambiguous_sweep/s);
    expect(sql[4]).toMatch(/DROP COLUMN IF EXISTS "first_send_attempted_at"/s);
    const allSql = sql.join('\n');
    expect(allSql).not.toMatch(/DROP TABLE/);
    expect(allSql).not.toMatch(/DROP COLUMN IF EXISTS "delivered_at"/);
  });

  it('does not commit, roll back, or release a caller-owned transaction', async () => {
    runner = mockRunner(true);
    await migration.down(runner);
    expect(runner.startTransaction).not.toHaveBeenCalled();
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('rolls back a transaction it owns when the evidence guard refuses', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('DO $$')) throw new Error('durable evidence');
      return [];
    });
    await expect(migration.down(runner)).rejects.toThrow('durable evidence');
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
  });
});
