import { Module } from '@nestjs/common';
import { TenantContextModule } from '../../common/tenant-context/tenant-context.module';
import { OdooRpcModule } from '../../integrations/odoo-rpc/odoo-rpc.module';
import { AuditModule } from '../audit/audit.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { ModuleSelectionController } from './module-selection.controller';
import { ModuleSelectionService } from './module-selection.service';
import { ModuleSelectionRecoveryWorker } from './module-selection-recovery.worker';

@Module({
  imports: [TenantContextModule, EntitlementsModule, OdooRpcModule, AuditModule],
  controllers: [ModuleSelectionController],
  providers: [ModuleSelectionService, ModuleSelectionRecoveryWorker],
  exports: [ModuleSelectionService, ModuleSelectionRecoveryWorker],
})
export class ModuleSelectionModule {}
