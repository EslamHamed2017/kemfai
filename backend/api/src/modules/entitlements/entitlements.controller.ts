import { Controller, Get, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../../common/guards/bearer-auth.guard';
import { EntitlementSet, EntitlementsService } from './entitlements.service';

/**
 * Authentication is applied globally (BearerAuthGuard via APP_GUARD, T017) — no
 * per-route @UseGuards needed; the route remains protected by the global guard chain.
 */
@Controller('entitlements')
export class EntitlementsController {
  constructor(private readonly entitlementsService: EntitlementsService) {}

  @Get('me')
  async getMine(@Req() req: AuthenticatedRequest): Promise<EntitlementSet> {
    return this.entitlementsService.getEntitlementSetForAccount(req.auth.keycloakUserId);
  }
}
