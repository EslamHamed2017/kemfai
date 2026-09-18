import { Module } from '@nestjs/common';
import { QueuesModule } from '../../common/queues/queues.module';
import { AuditModule } from '../../modules/audit/audit.module';
import { EntitlementsModule } from '../../modules/entitlements/entitlements.module';
import { TrialExpirySweepProcessor } from './trial-expiry-sweep.processor';

/**
 * T102 wiring: registers the `trial.expiry_sweep` worker. Schedule registration itself
 * (the fixed 30s repeatable job) is QueueSchedulingService's job (T021, QueuesModule) — this
 * module only supplies the job's consumer.
 */
@Module({
  imports: [QueuesModule, AuditModule, EntitlementsModule],
  providers: [TrialExpirySweepProcessor],
})
export class TrialExpirySweepModule {}
