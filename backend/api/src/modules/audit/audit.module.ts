import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditEventInterceptor } from '../../common/interceptors/audit-event.interceptor';
import { AuditController } from './audit.controller';

@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditEventInterceptor],
  exports: [AuditService, AuditEventInterceptor],
})
export class AuditModule {}
