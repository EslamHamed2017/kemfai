import { Module } from '@nestjs/common';
import { QueuesModule } from '../../common/queues/queues.module';
import { AuditModule } from '../../modules/audit/audit.module';
import { SupportAccessSweepProcessor } from './support-access-sweep.processor';

@Module({ imports: [QueuesModule, AuditModule], providers: [SupportAccessSweepProcessor] })
export class SupportAccessSweepModule {}
