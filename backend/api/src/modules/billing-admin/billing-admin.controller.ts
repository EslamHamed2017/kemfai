import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { BillingAdminService, PaymentSubmissionAdminView } from './billing-admin.service';

/** Internal manual-billing review surface (US6, T068). */
@Controller('internal/billing')
@Roles('BillingAdmin')
export class BillingAdminController {
  constructor(private readonly billingAdmin: BillingAdminService) {}

  @Get('review-queue')
  getReviewQueue(): Promise<PaymentSubmissionAdminView[]> {
    return this.billingAdmin.getReviewQueue();
  }
}
