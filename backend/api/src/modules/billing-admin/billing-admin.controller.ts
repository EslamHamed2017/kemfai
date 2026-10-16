import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedRequest } from '../../common/guards/bearer-auth.guard';
import { RejectPaymentSubmissionRequestDto } from './dto/reject-payment-submission.request.dto';
import { RequestMoreInfoPaymentSubmissionRequestDto } from './dto/request-more-info-payment-submission.request.dto';
import {
  BillingAdminService,
  BillingApprovalResult,
  BillingDecisionResult,
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

  @Post('payment-submissions/:submissionId/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('submissionId') submissionId: string,
    @Body() body: RejectPaymentSubmissionRequestDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<BillingDecisionResult> {
    return this.billingAdmin.reject(submissionId, req.auth.keycloakUserId, body.reason);
  }

  @Post('payment-submissions/:submissionId/request-more-info')
  @HttpCode(HttpStatus.OK)
  requestMoreInfo(
    @Param('submissionId') submissionId: string,
    @Body() body: RequestMoreInfoPaymentSubmissionRequestDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<BillingDecisionResult> {
    return this.billingAdmin.requestMoreInfo(submissionId, req.auth.keycloakUserId, body.details);
  }
}
