import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { In } from 'typeorm';
import controlDataSource from '../../database/data-source';
import { MinioStorageService } from '../../integrations/minio/minio-storage.service';
import {
  QUEUE_NOTIFICATION_BILLING_DECISION,
  billingDecisionNotificationJobId,
} from '../../common/queues/queue-names';
import {
  BillingDecisionNotificationOutboxRow,
  BillingDecisionNotificationOutboxService,
} from './billing-decision-notification-outbox.service';
import {
  AuditService,
  BillingActivationAuditFields,
  BillingDecision,
} from '../audit/audit.service';
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

export interface BillingDecisionResult {
  submissionId: string;
  status: PaymentSubmissionStatus.REJECTED | PaymentSubmissionStatus.MORE_INFO_REQUESTED;
  decision: Exclude<BillingDecision, 'approve'>;
  decisionNotes: string;
  decidedAt: string;
}

/** Cross-tenant Billing Admin reads over control-plane payment submissions (FR-034). */
@Injectable()
export class BillingAdminService {
  private readonly logger = new Logger(BillingAdminService.name);

  constructor(
    private readonly storage: MinioStorageService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_NOTIFICATION_BILLING_DECISION)
    private readonly billingDecisionNotificationQueue: Queue,
    private readonly notificationOutbox: BillingDecisionNotificationOutboxService,
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
    const outcome = await controlDataSource.transaction(async (manager) => {
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

      // FR-035 (T070 review finding 3): approvals notify the customer too. The
      // notification intent commits INSIDE the same transaction as the activation —
      // T069's atomicity is preserved, just carried by one more row — and the enqueue
      // happens only after the transaction resolves.
      const notificationOutboxRow = await this.notificationOutbox.recordPending(manager, {
        submissionId: savedSubmission.id,
        tenantId: savedSubmission.tenantId,
        decision: 'approve',
        decisionOccurrence: savedSubmission.statusHistory.length - 1,
        notes: null,
        occurredAt: decidedAt,
        jobId: billingDecisionNotificationJobId(
          savedSubmission.id,
          'approve',
          savedSubmission.statusHistory.length - 1,
        ),
      });

      return {
        approval: {
          submissionId: savedSubmission.id,
          subscriptionId: savedSubscription.id,
          status: SubscriptionStatus.ACTIVE,
          billingPeriodStart: savedSubscription.currentPeriodStart,
          billingPeriodEnd: savedSubscription.currentPeriodEnd,
          activatedAt: decidedAt.toISOString(),
        } satisfies BillingApprovalResult,
        notificationOutboxRow,
      };
    });

    await this.dispatchDecisionNotification(outcome.notificationOutboxRow);
    return outcome.approval;
  }

  /**
   * T070 — `POST /internal/billing/payment-submissions/{id}/reject` (Acceptance Scenario
   * 6.3, FR-035). Rejects the submission with a mandatory reason: the customer is
   * notified via `notification.billing_decision`, the subscription stays unactivated, and
   * the decision is audited with the full FR-009 field set.
   */
  async reject(
    submissionId: string,
    reviewerKeycloakUserId: string,
    reason: string,
  ): Promise<BillingDecisionResult> {
    const notes = mandatoryDecisionNotes(reason, 'reason');
    const outcome = await this.decide(
      submissionId,
      reviewerKeycloakUserId,
      'reject',
      PaymentSubmissionStatus.REJECTED,
      notes,
    );
    await this.dispatchDecisionNotification(outcome.notificationOutboxRow);
    return outcome.result;
  }

  /**
   * T070 — `POST /internal/billing/payment-submissions/{id}/request-more-info`
   * (Acceptance Scenario 6.4, FR-035). Appends a new MoreInfoRequested cycle to the
   * append-only `status_history` with the requested specifics as the latest notes,
   * returning the submission to a customer-actionable state (resubmission, T062).
   */
  async requestMoreInfo(
    submissionId: string,
    reviewerKeycloakUserId: string,
    details: string,
  ): Promise<BillingDecisionResult> {
    const notes = mandatoryDecisionNotes(details, 'details');
    const outcome = await this.decide(
      submissionId,
      reviewerKeycloakUserId,
      'more_info',
      PaymentSubmissionStatus.MORE_INFO_REQUESTED,
      notes,
    );
    await this.dispatchDecisionNotification(outcome.notificationOutboxRow);
    return outcome.result;
  }

  /**
   * Shared non-activating decision core. One pessimistic-lock transaction flips the
   * status, appends the history cycle, and writes the complete `billing.payment_submission.
   * decided` audit event — all commit or roll back together (the T035/T069 doctrine). The
   * subscription is deliberately NOT written: reject/more_info never activates (FR-036),
   * and `billing.subscription.activated` is never emitted for these decisions.
   */
  private async decide(
    submissionId: string,
    reviewerKeycloakUserId: string,
    decision: Exclude<BillingDecision, 'approve'>,
    targetStatus: PaymentSubmissionStatus.REJECTED | PaymentSubmissionStatus.MORE_INFO_REQUESTED,
    notes: string,
  ): Promise<{
    result: BillingDecisionResult;
    notificationOutboxRow: BillingDecisionNotificationOutboxRow;
  }> {
    const outcome = await controlDataSource.transaction(async (manager) => {
      const paymentRepository = manager.getRepository(PaymentSubmission);
      const submission = await paymentRepository.findOne({
        where: { id: submissionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!submission) {
        throw new NotFoundException('Payment submission was not found');
      }
      // Same decidable source state as approve (T069, data-model.md state machine):
      // decisions act on PendingReview; a MoreInfoRequested row first needs the
      // customer's resubmission, and terminal states are already decided.
      if (submission.status !== PaymentSubmissionStatus.PENDING_REVIEW) {
        throw new ConflictException('Payment submission has already been decided');
      }

      // Internal-realm principals are a distinct identity namespace from customer Accounts
      // (T069 identity doctrine). The verified internal subject is preserved verbatim in
      // history/audit; the customer-only `reviewed_by` Account FK stays null.
      const reviewerIdentityId = reviewerKeycloakUserId;
      const reviewerAccountId = null;

      const subscription = await manager.getRepository(Subscription).findOne({
        where: { id: submission.subscriptionId, tenantId: submission.tenantId },
      });
      if (!subscription) {
        throw new InternalServerErrorException(
          'The payment submission is not linked to a subscription',
        );
      }

      const tenant = await manager.getRepository(Tenant).findOne({
        where: { id: submission.tenantId },
      });
      if (!tenant) {
        throw new InternalServerErrorException('The payment submission is not linked to a tenant');
      }

      const decidedAt = new Date();
      const decisionHistory: PaymentSubmissionStatusHistoryEntry = {
        status: targetStatus,
        changedAt: decidedAt.toISOString(),
        changedBy: reviewerIdentityId,
        notes,
      };
      Object.assign(submission, {
        status: targetStatus,
        reviewedBy: reviewerAccountId,
        reviewedAt: decidedAt,
        decisionNotes: notes,
        statusHistory: [...submission.statusHistory, decisionHistory],
      });
      const savedSubmission = await paymentRepository.save(submission);

      // FR-009 field set, verbatim. `activated_by`/`activated_at` are carried as null: this
      // decision did not activate anything, and the audit must record that truthfully.
      const auditFields: BillingActivationAuditFields = {
        customer: tenant.accountId,
        tenant: savedSubmission.tenantId,
        plan: subscription.planId,
        billingPeriodStart: savedSubmission.billingPeriodStart,
        billingPeriodEnd: savedSubmission.billingPeriodEnd,
        amount: savedSubmission.amount,
        currency: savedSubmission.currency,
        bankReference: savedSubmission.bankReference,
        proofDocumentReference: savedSubmission.proofObjectKey,
        reviewedBy: reviewerIdentityId,
        reviewedAt: decidedAt,
        decision,
        activatedBy: null,
        activatedAt: null,
        notes,
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

      // T070 durability (review finding 1): the FR-035 notification intent commits in
      // the SAME transaction as the decision, history append, and audit — commit or
      // roll back together. The occurrence is the 0-based index of this decision's own
      // history entry, so repeated more-info cycles never collide at the queue (review
      // finding 2) while a retried SAME-occurrence write stays idempotent.
      const decisionOccurrence = savedSubmission.statusHistory.length - 1;
      const notificationOutboxRow = await this.notificationOutbox.recordPending(manager, {
        submissionId: savedSubmission.id,
        tenantId: savedSubmission.tenantId,
        decision,
        decisionOccurrence,
        notes,
        occurredAt: decidedAt,
        jobId: billingDecisionNotificationJobId(savedSubmission.id, decision, decisionOccurrence),
      });

      return { savedSubmission, decidedAt, notificationOutboxRow };
    });

    return {
      result: {
        submissionId: outcome.savedSubmission.id,
        status: targetStatus,
        decision,
        decisionNotes: notes,
        decidedAt: outcome.decidedAt.toISOString(),
      },
      notificationOutboxRow: outcome.notificationOutboxRow,
    };
  }

  /**
   * FR-035 customer notification — dispatches the outbox row committed with the
   * decision, strictly AFTER the decision transaction resolves (a rolled-back decision
   * must never notify, and its outbox row rolled back with it). The enqueue reuses the
   * exact job name/data/options the recovery path uses; BullMQ dedupes on the
   * occurrence-keyed job id. An enqueue or mark failure is logged for ops and left to
   * the durable `pending` row — the in-process recovery worker and the operator command
   * (`npm run notify:recover`) converge it with bounded backoff; the durable, audited
   * decision itself never fails because Redis is briefly unavailable.
   */
  private async dispatchDecisionNotification(
    row: BillingDecisionNotificationOutboxRow,
  ): Promise<void> {
    try {
      await this.notificationOutbox.dispatch(row, this.billingDecisionNotificationQueue);
    } catch (error) {
      this.logger.error(
        `notification.billing_decision enqueue failed for submission ${row.submissionId} ` +
          `(${row.decision}, job ${row.jobId}) — decision is durable and audited; the pending ` +
          `outbox row will be recovered with backoff`,
        error as Error,
      );
    }
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

/**
 * Decision notes are mandatory (FR-035: the customer must learn the rejection reason or
 * the specifics of the request). The HTTP layer enforces shape via the request DTOs; this
 * service-level guard keeps the invariant true for every caller — blank notes never reach
 * persistence, history, or audit.
 */
function mandatoryDecisionNotes(raw: string, field: 'reason' | 'details'): string {
  const notes = raw.trim();
  if (!notes) {
    throw new UnprocessableEntityException(`${field} must not be blank`);
  }
  return notes;
}
