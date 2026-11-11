import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ACCOUNTING_RECOVERY_JOB_NAME,
  ACCOUNTING_RECOVERY_REPEAT_INTERVAL_MS,
  QUEUE_ACCOUNTING_MUTATION_RECOVERY,
  QUEUE_SUPPORT_ACCESS_EXPIRY_SWEEP,
  QUEUE_TRIAL_EXPIRY_SWEEP,
  SWEEP_JOB_NAME,
  SWEEP_REPEAT_INTERVAL_MS,
} from './queue-names';

/**
 * Owns the "Scheduled, every 30s" rows of contracts/events.md's job table
 * (support_access.expiry_sweep and trial.expiry_sweep). The processors themselves land
 * with T090/T102; this service guarantees the schedule configuration exists in Redis as
 * soon as the app boots, idempotently, so later processor tasks only consume jobs.
 *
 * Live access denial is NEVER performed by these sweeps (T102/T101 split) — they are
 * observability/notification only.
 */
@Injectable()
export class QueueSchedulingService implements OnModuleInit {
  constructor(
    @InjectQueue(QUEUE_SUPPORT_ACCESS_EXPIRY_SWEEP)
    private readonly supportAccessSweepQueue: Queue,
    @InjectQueue(QUEUE_TRIAL_EXPIRY_SWEEP) private readonly trialSweepQueue: Queue,
    @InjectQueue(QUEUE_ACCOUNTING_MUTATION_RECOVERY)
    private readonly accountingRecoveryQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureSweepSchedules();
    if (process.env.KEMFAI_DISABLE_ACCOUNTING_RECOVERY_WORKER !== '1') {
      await this.ensureAccountingRecoverySchedule();
    }
  }

  /**
   * Register the fixed 30s repeatable job on each sweep queue if (and only if) the
   * documented schedule is not already present, making repeated bootstraps/restarts
   * no-ops (Constitution Principle VII). Sweep idempotency is "N/A (sweep, not
   * per-entity)" per events.md — one schedule per queue, no per-entity keys.
   */
  async ensureSweepSchedules(): Promise<void> {
    for (const queue of [this.supportAccessSweepQueue, this.trialSweepQueue]) {
      const existing = await queue.getRepeatableJobs();
      const alreadyRegistered = existing.some(
        (job) => job.name === SWEEP_JOB_NAME && job.every === String(SWEEP_REPEAT_INTERVAL_MS),
      );
      if (!alreadyRegistered) {
        await queue.add(SWEEP_JOB_NAME, {}, { repeat: { every: SWEEP_REPEAT_INTERVAL_MS } });
      }
    }
  }
  async ensureAccountingRecoverySchedule(): Promise<void> {
    const existing = await this.accountingRecoveryQueue.getRepeatableJobs();
    const registered = existing.some(
      (job) =>
        job.name === ACCOUNTING_RECOVERY_JOB_NAME &&
        job.every === String(ACCOUNTING_RECOVERY_REPEAT_INTERVAL_MS),
    );
    if (!registered) {
      await this.accountingRecoveryQueue.add(
        ACCOUNTING_RECOVERY_JOB_NAME,
        {},
        { repeat: { every: ACCOUNTING_RECOVERY_REPEAT_INTERVAL_MS } },
      );
    }
  }
}
