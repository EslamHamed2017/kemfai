import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditEventView, AuditService } from './audit.service';
import { AuditEventsQueryDto } from './dto/audit-events.query.dto';

@Controller('internal/audit-events')
@Roles('ReadOnlyManagement')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  findAll(@Query() query: AuditEventsQueryDto): Promise<AuditEventView[]> {
    return this.audit.findAll(query);
  }
}
