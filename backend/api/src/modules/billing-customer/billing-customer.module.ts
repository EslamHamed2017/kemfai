import { Module } from '@nestjs/common';
import { MinioModule } from '../../integrations/minio/minio.module';
import { AuditModule } from '../audit/audit.module';
import { BillingCustomerController } from './billing-customer.controller';
import { BillingCustomerService } from './billing-customer.service';

@Module({
  imports: [AuditModule, MinioModule],
  controllers: [BillingCustomerController],
  providers: [BillingCustomerService],
})
export class BillingCustomerModule {}
