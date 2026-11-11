import { QueryRunner } from 'typeorm';
import { AddAccountingMutationRejectedState1790002000000 } from './migrations/1790002000000-AddAccountingMutationRejectedState';

describe('AddAccountingMutationRejectedState1790002000000', () => {
  it('checks for rejected rows before destructive rollback DDL', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const runner = { query } as unknown as QueryRunner;

    await new AddAccountingMutationRejectedState1790002000000().down(runner);

    expect(query.mock.calls[0][0]).toContain(`WHERE "state" = 'rejected'`);
    expect(query.mock.calls[0][0]).toContain('RAISE EXCEPTION');
    expect(query.mock.calls[1][0]).toContain('DROP INDEX');
  });
});
