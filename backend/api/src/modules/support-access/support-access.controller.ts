import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { RequireFeatureFlag } from '../../common/decorators/feature-flag.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireSupportAccess } from '../../common/decorators/support-access.decorator';
import { TenantOwnedResource } from '../../common/tenant-context/tenant-owned-resource.decorator';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { CreateSupportAccessGrantDto } from './dto/create-support-access-grant.dto';
import { SUPPORT_WORKSPACE_SUMMARY_ACTION } from './entities/support-access-grant.entity';
import { SupportAccessService } from './support-access.service';
import { SupportWorkspaceService } from './support-workspace.service';

@Controller('support-access/grants')
@Roles('WorkspaceOwner')
@RequireFeatureFlag('module.support_access')
export class SupportAccessController {
  constructor(private readonly supportAccess: SupportAccessService) {}

  @Get()
  list(@Req() req: TenantScopedRequest) {
    return this.supportAccess.list(req);
  }

  @Post()
  create(@Req() req: TenantScopedRequest, @Body() body: CreateSupportAccessGrantDto) {
    return this.supportAccess.create(req, body);
  }

  @Post(':grantId/revoke')
  @HttpCode(HttpStatus.OK)
  @TenantOwnedResource({ resource: 'support_access_grant', idParam: 'grantId' })
  revoke(@Req() req: TenantScopedRequest, @Param('grantId', new ParseUUIDPipe()) grantId: string) {
    return this.supportAccess.revoke(req, grantId);
  }
}

@Controller('internal/support-access/workspaces')
@Roles('Support')
@RequireFeatureFlag('module.support_access')
export class SupportWorkspaceController {
  constructor(private readonly workspace: SupportWorkspaceService) {}

  @Get(':tenantId/summary')
  @RequireSupportAccess(SUPPORT_WORKSPACE_SUMMARY_ACTION)
  summary(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query('grantId', new ParseUUIDPipe()) grantId: string,
  ) {
    void grantId;
    return this.workspace.summary(tenantId);
  }
}
