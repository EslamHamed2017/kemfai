import { Module } from '@nestjs/common';
import { MinioModule } from '../../integrations/minio/minio.module';
import { BillingAdminController } from './billing-admin.controller';
import { BillingAdminService } from './billing-admin.service';

@Module({
  imports: [MinioModule],
  controllers: [BillingAdminController],
  providers: [BillingAdminService],
})
export class BillingAdminModule {}
