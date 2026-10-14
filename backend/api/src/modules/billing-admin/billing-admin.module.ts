import { Module } from '@nestjs/common';
import { MinioModule } from '../../integrations/minio/minio.module';
import { QueuesModule } from '../../common/queues/queues.module';
import { AuditModule } from '../audit/audit.module';
import { BillingAdminController } from './billing-admin.controller';
import { BillingAdminService } from './billing-admin.service';

@Module({
  imports: [AuditModule, MinioModule, QueuesModule],
  controllers: [BillingAdminController],
  providers: [BillingAdminService],
})
export class BillingAdminModule {}
