import { SupportAccessSweepProcessor } from './support-access-sweep.processor';

describe('SupportAccessSweepProcessor (T086/T090 RED)', () => {
  it('uses one atomic transition statement guarded by active status and cutoff', () => {
    const sql = SupportAccessSweepProcessor.atomicExpirySql;
    expect(sql).toMatch(/UPDATE\s+support_access_grant/i);
    expect(sql).toMatch(/status\s*=\s*'Active'/i);
    expect(sql).toMatch(/expires_at\s*<=/i);
    expect(sql).toMatch(/RETURNING/i);
  });
});
