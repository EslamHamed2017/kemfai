import { Queue } from 'bullmq';
import {
  ACCOUNTING_RECOVERY_JOB_NAME,
  ACCOUNTING_RECOVERY_REPEAT_INTERVAL_MS,
  SWEEP_JOB_NAME,
  SWEEP_REPEAT_INTERVAL_MS,
} from './queue-names';
import { QueueSchedulingService } from './queue-scheduling.service';

type RepeatableJob = { name: string; every: string };

function fakeQueue(repeatables: RepeatableJob[]) {
  const added: Array<{ name: string; opts: unknown }> = [];
  return {
    added,
    getRepeatableJobs: jest.fn(async () => [...repeatables]),
    add: jest.fn(async (name: string, _data: unknown, opts: unknown) => {
      added.push({ name, opts });
      return {} as never;
    }),
  };
}

function serviceFor(
  a: ReturnType<typeof fakeQueue>,
  b: ReturnType<typeof fakeQueue>,
  accounting: ReturnType<typeof fakeQueue> = fakeQueue([]),
) {
  return new QueueSchedulingService(
    a as unknown as Queue,
    b as unknown as Queue,
    accounting as unknown as Queue,
  );
}

/**
 * T021: the two sweep queues' schedule registration must mirror events.md's "Scheduled,
 * every 30s" rows and be a no-op when the documented schedule already exists — sweep
 * idempotency is the fixed repeatable job itself, never a per-entity key.
 */
describe('QueueSchedulingService (T021)', () => {
  it('registers one 30s repeatable sweep job on each sweep queue when none exists', async () => {
    const supportAccess = fakeQueue([]);
    const trial = fakeQueue([]);

    await serviceFor(supportAccess, trial).ensureSweepSchedules();

    for (const queue of [supportAccess, trial]) {
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        SWEEP_JOB_NAME,
        {},
        { repeat: { every: SWEEP_REPEAT_INTERVAL_MS } },
      );
    }
  });

  it('is a no-op when the documented 30s schedule is already registered (re-bootstrap)', async () => {
    const existing: RepeatableJob[] = [
      { name: SWEEP_JOB_NAME, every: String(SWEEP_REPEAT_INTERVAL_MS) },
    ];
    const supportAccess = fakeQueue(existing);
    const trial = fakeQueue(existing);

    await serviceFor(supportAccess, trial).ensureSweepSchedules();

    expect(supportAccess.add).not.toHaveBeenCalled();
    expect(trial.add).not.toHaveBeenCalled();
  });

  it('does not mistake a differently-configured repeatable for the documented schedule', async () => {
    const supportAccess = fakeQueue([{ name: SWEEP_JOB_NAME, every: '15000' }]);
    const trial = fakeQueue([{ name: 'other', every: String(SWEEP_REPEAT_INTERVAL_MS) }]);

    await serviceFor(supportAccess, trial).ensureSweepSchedules();

    expect(supportAccess.add).toHaveBeenCalledTimes(1);
    expect(trial.add).toHaveBeenCalledTimes(1);
  });
});

describe('Accounting recovery schedule (T037)', () => {
  it('registers one fixed repeatable recovery job and is idempotent on re-bootstrap', async () => {
    const accounting = fakeQueue([]);
    const service = serviceFor(fakeQueue([]), fakeQueue([]), accounting);
    await service.ensureAccountingRecoverySchedule();
    expect(accounting.add).toHaveBeenCalledWith(
      ACCOUNTING_RECOVERY_JOB_NAME,
      {},
      { repeat: { every: ACCOUNTING_RECOVERY_REPEAT_INTERVAL_MS } },
    );

    const existing = fakeQueue([
      {
        name: ACCOUNTING_RECOVERY_JOB_NAME,
        every: String(ACCOUNTING_RECOVERY_REPEAT_INTERVAL_MS),
      },
    ]);
    await serviceFor(fakeQueue([]), fakeQueue([]), existing).ensureAccountingRecoverySchedule();
    expect(existing.add).not.toHaveBeenCalled();
  });
});
