import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedRequest } from '../../common/guards/bearer-auth.guard';
import {
  BillingAdminService,
  BillingApprovalResult,
  PaymentSubmissionAdminView,
} from './billing-admin.service';

/** Internal manual-billing review surface (US6, T068). */
@Controller('internal/billing')
@Roles('BillingAdmin')
export class BillingAdminController {
  constructor(private readonly billingAdmin: BillingAdminService) {}

  @Get('review-queue')
  getReviewQueue(): Promise<PaymentSubmissionAdminView[]> {
    return this.billingAdmin.getReviewQueue();
  }

  @Post('payment-submissions/:submissionId/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('submissionId') submissionId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<BillingApprovalResult> {
    return this.billingAdmin.approve(submissionId, req.auth.keycloakUserId);
  }
}
