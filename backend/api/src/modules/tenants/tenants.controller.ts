import { Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../../common/guards/bearer-auth.guard';
import { TenantsService, TenantStatusResponse } from './tenants.service';

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get('me')
  status(@Req() req: AuthenticatedRequest): Promise<TenantStatusResponse> {
    return this.tenants.status(req.auth.keycloakUserId);
  }

  @Post('me/provisioning-retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retry(@Req() req: AuthenticatedRequest): Promise<TenantStatusResponse> {
    return this.tenants.retry(req.auth.keycloakUserId);
  }
}
