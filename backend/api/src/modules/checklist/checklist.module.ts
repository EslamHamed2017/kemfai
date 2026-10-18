import { Module } from '@nestjs/common';
import { TenantContextModule } from '../../common/tenant-context/tenant-context.module';
import { OdooRpcModule } from '../../integrations/odoo-rpc/odoo-rpc.module';
import { ChecklistController } from './checklist.controller';
import { ChecklistService } from './checklist.service';

@Module({
  imports: [TenantContextModule, OdooRpcModule],
  controllers: [ChecklistController],
  providers: [ChecklistService],
  exports: [ChecklistService],
})
export class ChecklistModule {}
