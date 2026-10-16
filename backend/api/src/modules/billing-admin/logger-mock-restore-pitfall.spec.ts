import { Logger } from '@nestjs/common';

/**
 * T070 regression guard (2026-10-16 logspy repair) — the exact root cause of a
 * real-PG/Redis failure that looked like "the delivery log line never got written":
 * `jest.SpyInstance#mockRestore()` does not just restore the original implementation,
 * it also CLEARS `.mock.calls` (the same effect as `mockReset()` plus restoring). A
 * test that reads `spy.mock.calls` AFTER calling `spy.mockRestore()` — even inside a
 * `try { ... } finally { spy.mockRestore(); }` block, if the read happens after the
 * `finally` — always sees an empty array, regardless of what was actually logged.
 * The fix is to copy `.mock.calls` INSIDE the `try`, before the guaranteed restore.
 * This spec pins that exact Jest behavior with the installed jest-mock version, using
 * the SAME `Logger.prototype.log` spy target as the real integration test, so a Jest
 * upgrade that changed this behavior (unlikely, but it's exactly the kind of thing that
 * silently breaks a test's assumptions) would be caught here, in a test that runs with
 * zero infrastructure.
 */
describe('jest.spyOn(...).mockRestore() clears .mock.calls (T070 logspy repair, 2026-10-16)', () => {
  it('reading mock.calls AFTER mockRestore() sees nothing, even though the call genuinely happened', () => {
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const logger = new Logger('pitfall-demo');

    logger.log('real-observation');
    expect(spy.mock.calls).toHaveLength(1);

    spy.mockRestore();

    // This is the exact mistake: the call genuinely happened, but history is gone.
    expect(spy.mock.calls).toHaveLength(0);
  });

  it('the fix: copying .mock.calls BEFORE mockRestore() preserves the real observation', () => {
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const logger = new Logger('pitfall-demo');

    let capturedCalls: unknown[][] = [];
    try {
      logger.log('real-observation');
      capturedCalls = spy.mock.calls.map((call) => [...call]);
    } finally {
      spy.mockRestore();
    }

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0][0]).toBe('real-observation');
    // The underlying spy's own history is still gone post-restore — the COPY is what
    // carries the evidence forward, not the spy itself.
    expect(spy.mock.calls).toHaveLength(0);
  });
});
