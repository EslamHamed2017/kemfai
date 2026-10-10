import { Controller, Get, Req } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedRequest } from '../../common/guards/bearer-auth.guard';
import { BillingCustomerService, SubscriptionView } from './billing-customer.service';

/** Customer-owned manual-billing reads for US5. T062 adds submission routes later. */
@Controller('billing')
export class BillingCustomerController {
  constructor(private readonly billingCustomer: BillingCustomerService) {}

  @Get('subscription')
  @Roles('WorkspaceOwner')
  getSubscription(@Req() req: AuthenticatedRequest): Promise<SubscriptionView> {
    return this.billingCustomer.getSubscription(req.auth.keycloakUserId);
  }
}
