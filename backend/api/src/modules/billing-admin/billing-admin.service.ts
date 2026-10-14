import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { In } from 'typeorm';
import controlDataSource from '../../database/data-source';
import { MinioStorageService } from '../../integrations/minio/minio-storage.service';
import { AuditService, BillingActivationAuditFields } from '../audit/audit.service';
import {
  PaymentSubmission,
  PaymentSubmissionStatus,
  PaymentSubmissionStatusHistoryEntry,
} from '../billing-customer/entities/payment-submission.entity';
import { Subscription, SubscriptionStatus } from '../billing-customer/entities/subscription.entity';
import { Tenant } from '../tenants/entities/tenant.entity';

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

export interface BillingApprovalResult {
  submissionId: string;
  subscriptionId: string;
  status: SubscriptionStatus.ACTIVE;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  activatedAt: string;
}

/** Cross-tenant Billing Admin reads over control-plane payment submissions (FR-034). */
@Injectable()
export class BillingAdminService {
  constructor(
    private readonly storage: MinioStorageService,
    private readonly audit: AuditService,
  ) {}

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

  async approve(
    submissionId: string,
    reviewerKeycloakUserId: string,
  ): Promise<BillingApprovalResult> {
    return controlDataSource.transaction(async (manager) => {
      const paymentRepository = manager.getRepository(PaymentSubmission);
      const submission = await paymentRepository.findOne({
        where: { id: submissionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!submission) {
        throw new NotFoundException('Payment submission was not found');
      }

      const subscriptionRepository = manager.getRepository(Subscription);
      const subscription = await subscriptionRepository.findOne({
        where: { id: submission.subscriptionId, tenantId: submission.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!subscription) {
        throw new InternalServerErrorException(
          'The payment submission is not linked to a subscription',
        );
      }

      const samePeriodIsActive =
        subscription.status === SubscriptionStatus.ACTIVE &&
        subscription.currentPeriodStart === submission.billingPeriodStart &&
        subscription.currentPeriodEnd === submission.billingPeriodEnd;
      if (samePeriodIsActive) {
        throw new ConflictException('Subscription is already active for this billing period');
      }
      if (submission.status !== PaymentSubmissionStatus.PENDING_REVIEW) {
        throw new ConflictException('Payment submission has already been decided');
      }

      // Internal-realm principals are a distinct identity namespace from customer Accounts.
      // Preserve the verified subject in history/audit and leave the customer-only Account FKs
      // null until an explicit, governed internal-user model exists. Looking up this subject in
      // Account would alias identities whenever the two realms issue the same UUID.
      const reviewerIdentityId = reviewerKeycloakUserId;
      const reviewerAccountId = null;

      const tenant = await manager.getRepository(Tenant).findOne({
        where: { id: submission.tenantId },
      });
      if (!tenant) {
        throw new InternalServerErrorException('The payment submission is not linked to a tenant');
      }

      const decidedAt = new Date();
      const approvalHistory: PaymentSubmissionStatusHistoryEntry = {
        status: PaymentSubmissionStatus.APPROVED,
        changedAt: decidedAt.toISOString(),
        changedBy: reviewerIdentityId,
        notes: null,
      };
      Object.assign(submission, {
        status: PaymentSubmissionStatus.APPROVED,
        reviewedBy: reviewerAccountId,
        reviewedAt: decidedAt,
        decisionNotes: null,
        statusHistory: [...submission.statusHistory, approvalHistory],
      });
      Object.assign(subscription, {
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: submission.billingPeriodStart,
        currentPeriodEnd: submission.billingPeriodEnd,
        activatedBy: reviewerAccountId,
        activatedAt: decidedAt,
      });

      const savedSubmission = await paymentRepository.save(submission);
      const savedSubscription = await subscriptionRepository.save(subscription);
      const auditFields: BillingActivationAuditFields = {
        customer: tenant.accountId,
        tenant: savedSubmission.tenantId,
        plan: savedSubscription.planId,
        billingPeriodStart: savedSubmission.billingPeriodStart,
        billingPeriodEnd: savedSubmission.billingPeriodEnd,
        amount: savedSubmission.amount,
        currency: savedSubmission.currency,
        bankReference: savedSubmission.bankReference,
        proofDocumentReference: savedSubmission.proofObjectKey,
        reviewedBy: reviewerIdentityId,
        reviewedAt: decidedAt,
        decision: 'approve',
        activatedBy: reviewerIdentityId,
        activatedAt: decidedAt,
        notes: savedSubmission.decisionNotes,
        statusHistory: savedSubmission.statusHistory,
      };

      await this.audit.recordBillingPaymentSubmissionDecided(
        {
          reviewerInternalUserId: reviewerIdentityId,
          tenantId: savedSubmission.tenantId,
          paymentSubmissionId: savedSubmission.id,
          occurredAt: decidedAt,
          ...auditFields,
        },
        manager,
      );
      await this.audit.recordBillingSubscriptionActivated(
        {
          activatedByInternalUserId: reviewerIdentityId,
          tenantId: savedSubscription.tenantId,
          subscriptionId: savedSubscription.id,
          occurredAt: decidedAt,
          ...auditFields,
        },
        manager,
      );

      return {
        submissionId: savedSubmission.id,
        subscriptionId: savedSubscription.id,
        status: SubscriptionStatus.ACTIVE,
        billingPeriodStart: savedSubscription.currentPeriodStart,
        billingPeriodEnd: savedSubscription.currentPeriodEnd,
        activatedAt: decidedAt.toISOString(),
      };
    });
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
