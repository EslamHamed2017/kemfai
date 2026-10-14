import { Module } from '@nestjs/common';
import { MinioModule } from '../../integrations/minio/minio.module';
import { QueuesModule } from '../../common/queues/queues.module';
import { AuditModule } from '../audit/audit.module';
import { BillingAdminController } from './billing-admin.controller';
import { BillingAdminService } from './billing-admin.service';
import { BillingDecisionNotificationOutboxService } from './billing-decision-notification-outbox.service';
import { BillingDecisionNotificationRecoveryWorker } from './billing-decision-notification-recovery.worker';

@Module({
  imports: [AuditModule, MinioModule, QueuesModule],
  controllers: [BillingAdminController],
  providers: [
    BillingAdminService,
    // T070 durability: the outbox data access plus the recovery worker registered in
    // the REAL module graph (AppModule imports this module), so pending notification
    // rows are reconciled by every API replica without any further HTTP request.
    BillingDecisionNotificationOutboxService,
    BillingDecisionNotificationRecoveryWorker,
  ],
})
export class BillingAdminModule {}
