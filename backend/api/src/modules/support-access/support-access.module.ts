import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { TenantContextModule } from '../../common/tenant-context/tenant-context.module';
import { SupportAccessController, SupportWorkspaceController } from './support-access.controller';
import { SupportAccessService } from './support-access.service';
import { SupportWorkspaceService } from './support-workspace.service';

@Module({
  imports: [AuditModule, TenantContextModule],
  controllers: [SupportAccessController, SupportWorkspaceController],
  providers: [SupportAccessService, SupportWorkspaceService],
  exports: [SupportAccessService],
})
export class SupportAccessModule {}
