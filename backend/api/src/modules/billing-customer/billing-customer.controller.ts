import {
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  PayloadTooLargeException,
  Post,
  Req,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedRequest } from '../../common/guards/bearer-auth.guard';
import {
  BillingCustomerService,
  MAX_PAYMENT_PROOF_BYTES,
  PaymentProofUpload,
  PaymentSubmissionView,
  SubscriptionView,
} from './billing-customer.service';

/** Maps Multer's pre-handler size rejection onto the committed 422 billing contract. */
@Catch(PayloadTooLargeException)
export class PaymentProofTooLargeFilter implements ExceptionFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(422).json({
      statusCode: 422,
      code: 'PAYMENT_PROOF_TOO_LARGE',
      message: 'Proof file exceeds the upload size limit',
    });
  }
}

/** Customer-owned manual-bank-transfer billing surface (US5, T061/T062). */
@Controller('billing')
export class BillingCustomerController {
  constructor(private readonly billingCustomer: BillingCustomerService) {}

  @Get('subscription')
  @Roles('WorkspaceOwner')
  getSubscription(@Req() req: AuthenticatedRequest): Promise<SubscriptionView> {
    return this.billingCustomer.getSubscription(req.auth.keycloakUserId);
  }

  @Get('payment-submissions')
  @Roles('WorkspaceOwner')
  getPaymentSubmissions(@Req() req: AuthenticatedRequest): Promise<PaymentSubmissionView[]> {
    return this.billingCustomer.getPaymentSubmissions(req.auth.keycloakUserId);
  }

  @Post('payment-submissions')
  @Roles('WorkspaceOwner')
  @UseFilters(PaymentProofTooLargeFilter)
  @UseInterceptors(
    FileInterceptor('proofFile', {
      limits: { fileSize: MAX_PAYMENT_PROOF_BYTES },
    }),
  )
  createPaymentSubmission(
    @Req() req: AuthenticatedRequest,
    @UploadedFile() proofFile: PaymentProofUpload | undefined,
  ): Promise<PaymentSubmissionView> {
    const bankReference = (req.body as { bankReference?: unknown } | undefined)?.bankReference;
    return this.billingCustomer.createPaymentSubmission(
      req.auth.keycloakUserId,
      bankReference,
      proofFile,
    );
  }
}
