import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditEventInterceptor } from '../../common/interceptors/audit-event.interceptor';

@Module({
  providers: [AuditService, AuditEventInterceptor],
  exports: [AuditService, AuditEventInterceptor],
})
export class AuditModule {}
