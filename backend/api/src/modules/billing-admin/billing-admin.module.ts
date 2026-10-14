import { Module } from '@nestjs/common';
import { MinioModule } from '../../integrations/minio/minio.module';
import { QueuesModule } from '../../common/queues/queues.module';
import { AuditModule } from '../audit/audit.module';
import { BillingAdminController } from './billing-admin.controller';
import { BillingAdminService } from './billing-admin.service';
import { BillingDecisionNotificationOutboxService } from './billing-decision-notification-outbox.service';
import { BillingDecisionNotificationRecoveryWorker } from './billing-decision-notification-recovery.worker';
import { BillingDecisionNotificationProcessor } from './billing-decision-notification.processor';
import { BILLING_DECISION_NOTIFICATION_TRANSPORT } from './billing-decision-notification-transport.contract';
import { SmtpBillingDecisionNotificationTransport } from './billing-decision-notification-transport';

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
    // T070 delivery (FR-035): the queue consumer and its real SMTP transport — the
    // customer is actually notified, with BullMQ's retries/backoff covering transient
    // relay failures and the transport throwing when SMTP is misconfigured so a job
    // can never complete silently undelivered.
    BillingDecisionNotificationProcessor,
    {
      provide: BILLING_DECISION_NOTIFICATION_TRANSPORT,
      useClass: SmtpBillingDecisionNotificationTransport,
    },
  ],
})
export class BillingAdminModule {}
