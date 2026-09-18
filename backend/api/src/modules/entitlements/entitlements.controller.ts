import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, BearerAuthGuard } from '../../common/guards/bearer-auth.guard';
import { EntitlementSet, EntitlementsService } from './entitlements.service';

@Controller('entitlements')
export class EntitlementsController {
  constructor(private readonly entitlementsService: EntitlementsService) {}

  @Get('me')
  @UseGuards(BearerAuthGuard)
  async getMine(@Req() req: AuthenticatedRequest): Promise<EntitlementSet> {
    return this.entitlementsService.getEntitlementSetForAccount(req.auth.keycloakUserId);
  }
}
