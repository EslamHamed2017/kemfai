import { Module } from '@nestjs/common';
import { CompanySetupController } from './company-setup.controller';
import { CompanySetupService } from './company-setup.service';
import { CompanySettingsController } from './company-settings.controller';
import { CompanySettingsService } from './company-settings.service';
import { CompanyOdooContextService } from './company-odoo-context.service';
import { CompanyMutationHandoffService } from './company-mutation-handoff.service';
import { CompanyMutationRecoveryWorker } from './company-mutation-recovery.worker';
import { TenantContextModule } from '../../common/tenant-context/tenant-context.module';
import { OdooRpcModule } from '../../integrations/odoo-rpc/odoo-rpc.module';
import { AuditModule } from '../audit/audit.module';

/**
 * T055 arbiter binding resolution, point 4 — `CompanyMutationRecoveryWorker` is an
 * ordinary provider here, booted by Nest's own module graph (this module is imported by
 * `AppModule`) exactly like every other provider below — never a second, isolated test
 * module that happens to be missing the `OnModuleInit` lifecycle wiring that actually
 * starts it.
 */
@Module({
  imports: [TenantContextModule, OdooRpcModule, AuditModule],
  controllers: [CompanySetupController, CompanySettingsController],
  providers: [
    CompanySetupService,
    CompanySettingsService,
    CompanyOdooContextService,
    CompanyMutationHandoffService,
    CompanyMutationRecoveryWorker,
  ],
  exports: [CompanyMutationHandoffService, CompanyMutationRecoveryWorker],
})
export class CompanySetupModule {}
