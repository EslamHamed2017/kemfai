import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { In } from 'typeorm';
import controlDataSource from '../../database/data-source';
import { MinioStorageService } from '../../integrations/minio/minio-storage.service';
import {
  PaymentSubmission,
  PaymentSubmissionStatus,
  PaymentSubmissionStatusHistoryEntry,
} from '../billing-customer/entities/payment-submission.entity';

export interface PaymentSubmissionAdminView {
  id: string;
  status: PaymentSubmissionStatus;
  submittedAt: string;
  statusHistory: PaymentSubmissionStatusHistoryEntry[];
  customerEmail: string;
  tenantId: string;
  planName: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  amount: number;
  currency: string;
  bankReference: string;
  proofDownloadUrl: string;
}

/** Cross-tenant Billing Admin reads over control-plane payment submissions (FR-034). */
@Injectable()
export class BillingAdminService {
  constructor(private readonly storage: MinioStorageService) {}

  async getReviewQueue(): Promise<PaymentSubmissionAdminView[]> {
    const submissions = await controlDataSource.getRepository(PaymentSubmission).find({
      where: {
        status: In([
          PaymentSubmissionStatus.PENDING_REVIEW,
          PaymentSubmissionStatus.MORE_INFO_REQUESTED,
        ]),
      },
      relations: {
        tenant: { account: true },
        subscription: { plan: true },
      },
      order: { submittedAt: 'ASC', id: 'ASC' },
    });

    return Promise.all(submissions.map((submission) => this.adminView(submission)));
  }

  private async adminView(submission: PaymentSubmission): Promise<PaymentSubmissionAdminView> {
    const bucket = submission.tenant.minioBucket;
    if (!bucket) {
      throw new InternalServerErrorException(
        'Payment-proof storage is unavailable for this submission',
      );
    }
    const proofDownloadUrl = await this.storage.getPresignedDownloadUrl(
      bucket,
      submission.proofObjectKey,
    );

    return {
      id: submission.id,
      status: submission.status,
      submittedAt: submission.submittedAt.toISOString(),
      statusHistory: submission.statusHistory,
      customerEmail: submission.tenant.account.email,
      tenantId: submission.tenantId,
      planName: submission.subscription.plan.name,
      billingPeriodStart: submission.billingPeriodStart,
      billingPeriodEnd: submission.billingPeriodEnd,
      amount: Number(submission.amount),
      currency: submission.currency,
      bankReference: submission.bankReference,
      proofDownloadUrl,
    };
  }
}
