import { Module } from '@nestjs/common';
import { CompanySetupController } from './company-setup.controller';
import { CompanySetupService } from './company-setup.service';
import { TenantContextModule } from '../../common/tenant-context/tenant-context.module';
import { OdooRpcModule } from '../../integrations/odoo-rpc/odoo-rpc.module';

@Module({
  imports: [TenantContextModule, OdooRpcModule],
  controllers: [CompanySetupController],
  providers: [CompanySetupService],
})
export class CompanySetupModule {}
