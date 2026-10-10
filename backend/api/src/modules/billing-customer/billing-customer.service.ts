import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { QueryFailedError } from 'typeorm';
import controlDataSource from '../../database/data-source';
import { MinioStorageService } from '../../integrations/minio/minio-storage.service';
import {
  paymentSubmissionObjectKey,
  tenantBucketName,
} from '../../integrations/minio/tenant-bucket-naming';
import { Account, Locale } from '../accounts/entities/account.entity';
import { AuditService } from '../audit/audit.service';
import { Plan } from '../entitlements/entities/plan.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import {
  PaymentSubmission,
  PaymentSubmissionStatus,
  PaymentSubmissionStatusHistoryEntry,
} from './entities/payment-submission.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from './entities/subscription.entity';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PAYMENT_PROOF_BYTES = 10 * 1024 * 1024;
const UNRESOLVED_PERIOD_CONSTRAINT = 'uq_payment_submission_unresolved_period';
const BANK_REFERENCE_CONSTRAINT = 'uq_payment_submission_bank_reference';

export interface PaymentProofUpload {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface PaymentSubmissionView {
  id: string;
  status: PaymentSubmissionStatus;
  submittedAt: string;
  statusHistory: PaymentSubmissionStatusHistoryEntry[];
}

export interface SubscriptionView {
  status: SubscriptionStatus;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  amountDue: number;
  currency: string;
  bankInstructions: string;
  paymentReference: string;
}

/**
 * Reads the caller's billing relationship from control-plane records created by T044.
 * Identity is always the verified JWT subject; no tenant, subscription, amount, currency,
 * or reference is accepted from the client.
 */
@Injectable()
export class BillingCustomerService {
  constructor(
    private readonly storage: MinioStorageService,
    private readonly audit: AuditService,
  ) {}

  async getSubscription(keycloakUserId: string): Promise<SubscriptionView> {
    const { account, tenant } = await this.resolveCustomer(keycloakUserId);

    const subscription = await controlDataSource.getRepository(Subscription).findOne({
      where: { tenantId: tenant.id },
    });
    if (!subscription) {
      throw new NotFoundException('No subscription is linked to the authenticated tenant');
    }

    const plan = await controlDataSource.getRepository(Plan).findOne({
      where: { id: subscription.planId },
    });
    if (!plan) {
      throw new InternalServerErrorException('The subscription plan is unavailable');
    }

    const amountDue = Number(this.amountForCycle(plan, subscription.billingCycle));
    const locale = account.preferredLocale ?? Locale.EN;

    return {
      status: subscription.status,
      billingPeriodStart: subscription.currentPeriodStart,
      billingPeriodEnd: subscription.currentPeriodEnd,
      amountDue,
      currency: plan.currency,
      bankInstructions: bankInstructionsFor(locale),
      paymentReference: paymentReferenceFor(tenant.id, subscription),
    };
  }

  /** Customer-scoped read; no tenant identifier from the request is ever accepted. */
  async getPaymentSubmissions(keycloakUserId: string): Promise<PaymentSubmissionView[]> {
    const { tenant } = await this.resolveCustomer(keycloakUserId);
    const submissions = await controlDataSource.getRepository(PaymentSubmission).find({
      where: { tenantId: tenant.id },
      order: { submittedAt: 'DESC' },
    });
    return submissions.map((submission) => this.submissionView(submission));
  }

  /**
   * Validates the complete in-memory file before any persistence, uploads into the
   * provisioned tenant-private bucket, then commits the row/state transition and its
   * mandatory audit event atomically in PostgreSQL. An upload is compensated if that
   * transaction fails, so a rejected duplicate cannot leave a new unlinked proof.
   */
  async createPaymentSubmission(
    keycloakUserId: string,
    bankReferenceInput: unknown,
    proof: PaymentProofUpload | undefined,
  ): Promise<PaymentSubmissionView> {
    this.validateProof(proof);
    if (typeof bankReferenceInput !== 'string' || !bankReferenceInput.trim()) {
      throw paymentSubmissionValidationError(
        'PAYMENT_BANK_REFERENCE_REQUIRED',
        'Bank transfer reference is required',
      );
    }
    const bankReference = bankReferenceInput.trim();

    const { account, tenant } = await this.resolveCustomer(keycloakUserId);
    const subscription = await controlDataSource.getRepository(Subscription).findOne({
      where: { tenantId: tenant.id },
    });
    if (!subscription) {
      throw new NotFoundException('No subscription is linked to the authenticated tenant');
    }
    const plan = await controlDataSource.getRepository(Plan).findOne({
      where: { id: subscription.planId },
    });
    if (!plan) {
      throw new InternalServerErrorException('The subscription plan is unavailable');
    }
    // Fail before object upload if the configured price is already invalid. The locked
    // plan row is read again inside the transaction for the actual persisted snapshot.
    this.amountForCycle(plan, subscription.billingCycle);

    const submissions = controlDataSource.getRepository(PaymentSubmission);
    const unresolved = await submissions.findOne({
      where: [
        {
          tenantId: tenant.id,
          billingPeriodStart: subscription.currentPeriodStart,
          billingPeriodEnd: subscription.currentPeriodEnd,
          status: PaymentSubmissionStatus.PENDING_REVIEW,
        },
        {
          tenantId: tenant.id,
          billingPeriodStart: subscription.currentPeriodStart,
          billingPeriodEnd: subscription.currentPeriodEnd,
          status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
        },
      ],
    });
    if (unresolved?.status === PaymentSubmissionStatus.PENDING_REVIEW) {
      throw unresolvedSubmissionConflict();
    }

    const expectedBucket = tenantBucketName(tenant.id);
    if (!tenant.minioBucket || tenant.minioBucket !== expectedBucket) {
      throw new ServiceUnavailableException('Payment-proof storage is unavailable for this tenant');
    }

    const submissionId = unresolved?.id ?? randomUUID();
    const objectKey = paymentSubmissionObjectKey(
      submissionId,
      `${randomUUID()}-${safeEvidenceFilename(proof.originalname, proof.mimetype)}`,
    );
    let uploaded = false;
    let transactionBodyFailed = false;

    try {
      await this.storage.putObject(expectedBucket, objectKey, proof.buffer, {
        'Content-Type': proof.mimetype,
      });
      uploaded = true;

      return await controlDataSource.transaction(async (manager) => {
        try {
          const lockedSubscription = await manager.getRepository(Subscription).findOne({
            where: { id: subscription.id, tenantId: tenant.id },
            lock: { mode: 'pessimistic_write' },
          });
          if (!lockedSubscription) {
            throw new NotFoundException('No subscription is linked to the authenticated tenant');
          }
          if (
            lockedSubscription.currentPeriodStart !== subscription.currentPeriodStart ||
            lockedSubscription.currentPeriodEnd !== subscription.currentPeriodEnd ||
            lockedSubscription.planId !== subscription.planId ||
            lockedSubscription.billingCycle !== subscription.billingCycle
          ) {
            throw subscriptionChangedConflict();
          }
          const lockedPlan = await manager.getRepository(Plan).findOne({
            where: { id: lockedSubscription.planId },
            lock: { mode: 'pessimistic_read' },
          });
          if (!lockedPlan) {
            throw new InternalServerErrorException('The subscription plan is unavailable');
          }

          const amount = this.amountForCycle(lockedPlan, lockedSubscription.billingCycle);
          const paymentRepository = manager.getRepository(PaymentSubmission);
          const submittedAt = new Date();
          const historyEntry: PaymentSubmissionStatusHistoryEntry = {
            status: PaymentSubmissionStatus.PENDING_REVIEW,
            changedAt: submittedAt.toISOString(),
            changedBy: account.id,
            notes: null,
            bankReference,
            proofObjectKey: objectKey,
          };

          let submission: PaymentSubmission;
          if (unresolved) {
            const locked = await paymentRepository.findOne({
              where: { id: unresolved.id, tenantId: tenant.id },
              lock: { mode: 'pessimistic_write' },
            });
            if (!locked || locked.status !== PaymentSubmissionStatus.MORE_INFO_REQUESTED) {
              throw unresolvedSubmissionConflict();
            }
            submission = Object.assign(locked, {
              bankReference,
              proofObjectKey: objectKey,
              status: PaymentSubmissionStatus.PENDING_REVIEW,
              submittedAt,
              reviewedBy: null,
              reviewedAt: null,
              decisionNotes: null,
              statusHistory: [...locked.statusHistory, historyEntry],
            });
          } else {
            submission = paymentRepository.create({
              id: submissionId,
              tenantId: tenant.id,
              subscriptionId: lockedSubscription.id,
              billingPeriodStart: lockedSubscription.currentPeriodStart,
              billingPeriodEnd: lockedSubscription.currentPeriodEnd,
              amount,
              currency: lockedPlan.currency,
              bankReference,
              proofObjectKey: objectKey,
              status: PaymentSubmissionStatus.PENDING_REVIEW,
              submittedAt,
              reviewedBy: null,
              reviewedAt: null,
              decisionNotes: null,
              statusHistory: [historyEntry],
            });
          }

          const saved = await paymentRepository.save(submission);
          await this.audit.recordBillingPaymentSubmissionCreated(
            {
              accountId: account.id,
              tenantId: tenant.id,
              paymentSubmissionId: saved.id,
              bankReference,
              amount: saved.amount,
              currency: saved.currency,
              billingPeriodStart: lockedSubscription.currentPeriodStart,
              billingPeriodEnd: lockedSubscription.currentPeriodEnd,
              occurredAt: saved.submittedAt,
            },
            manager,
          );
          return this.submissionView(saved);
        } catch (error) {
          // The callback did not complete, so TypeORM cannot enter COMMIT; cleanup is
          // safe after rollback. A rejection after this callback returns is an ambiguous
          // commit acknowledgement and deliberately keeps the proof object intact.
          transactionBodyFailed = true;
          throw error;
        }
      });
    } catch (error) {
      if (uploaded && transactionBodyFailed) {
        try {
          await this.storage.removeObject(expectedBucket, objectKey);
        } catch {
          throw new ServiceUnavailableException(
            'Payment submission failed and its uploaded proof could not be cleaned up safely',
          );
        }
      }
      if (error instanceof ConflictException) {
        throw error;
      }
      if (isPaymentSubmissionConflict(error)) {
        throw unresolvedSubmissionConflict();
      }
      throw error;
    }
  }

  private async resolveCustomer(
    keycloakUserId: string,
  ): Promise<{ account: Account; tenant: Tenant }> {
    if (!UUID_PATTERN.test(keycloakUserId)) {
      throw new UnauthorizedException('No account is linked to the authenticated user');
    }
    const account = await controlDataSource.getRepository(Account).findOne({
      where: { keycloakUserId },
    });
    if (!account) {
      throw new UnauthorizedException('No account is linked to the authenticated user');
    }
    const tenant = await controlDataSource.getRepository(Tenant).findOne({
      where: { accountId: account.id },
    });
    if (!tenant) {
      throw new NotFoundException('No tenant is linked to the authenticated account');
    }
    return { account, tenant };
  }

  private amountForCycle(plan: Plan, cycle: SubscriptionBillingCycle): string {
    const rawAmount =
      cycle === SubscriptionBillingCycle.MONTHLY
        ? plan.monthlyPrice
        : cycle === SubscriptionBillingCycle.ANNUAL
          ? plan.annualPrice
          : null;
    const amount = rawAmount === null ? Number.NaN : Number(rawAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new InternalServerErrorException('The subscription price is invalid');
    }
    return rawAmount as string;
  }

  private submissionView(submission: PaymentSubmission): PaymentSubmissionView {
    const submittedAt =
      submission.submittedAt instanceof Date
        ? submission.submittedAt.toISOString()
        : new Date(submission.submittedAt).toISOString();
    return {
      id: submission.id,
      status: submission.status,
      submittedAt,
      statusHistory: submission.statusHistory,
    };
  }

  private validateProof(
    proof: PaymentProofUpload | undefined,
  ): asserts proof is PaymentProofUpload {
    if (!proof || !Buffer.isBuffer(proof.buffer) || proof.buffer.length === 0) {
      throw paymentSubmissionValidationError(
        'PAYMENT_PROOF_UNREADABLE',
        'Proof file could not be read',
      );
    }
    if (!isSupportedMimeType(proof.mimetype)) {
      throw paymentSubmissionValidationError(
        'PAYMENT_PROOF_UNSUPPORTED_TYPE',
        'Proof file type is not supported',
      );
    }
    if (proof.size > MAX_PAYMENT_PROOF_BYTES || proof.buffer.length > MAX_PAYMENT_PROOF_BYTES) {
      throw paymentSubmissionValidationError(
        'PAYMENT_PROOF_TOO_LARGE',
        'Proof file exceeds the upload size limit',
      );
    }
    if (
      proof.size !== proof.buffer.length ||
      !bytesMatchDeclaredType(proof.buffer, proof.mimetype)
    ) {
      throw paymentSubmissionValidationError(
        'PAYMENT_PROOF_UNREADABLE',
        'Proof file could not be read',
      );
    }
  }
}

function paymentSubmissionValidationError(
  code: string,
  message: string,
): UnprocessableEntityException {
  return new UnprocessableEntityException({ statusCode: 422, code, message });
}

function unresolvedSubmissionConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'PAYMENT_SUBMISSION_UNRESOLVED_DUPLICATE',
    message: 'An unresolved payment submission already exists for this billing period',
  });
}

function subscriptionChangedConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'PAYMENT_SUBSCRIPTION_PERIOD_CHANGED',
    message: 'The subscription billing period changed; reload billing details and try again',
  });
}

function isPaymentSubmissionConflict(error: unknown): boolean {
  const driverError =
    error instanceof QueryFailedError
      ? (error.driverError as { code?: string; constraint?: string })
      : (error as { code?: string; constraint?: string });
  return (
    driverError?.code === '23505' &&
    [UNRESOLVED_PERIOD_CONSTRAINT, BANK_REFERENCE_CONSTRAINT].includes(driverError.constraint ?? '')
  );
}

function isSupportedMimeType(mime: string): mime is 'application/pdf' | 'image/png' | 'image/jpeg' {
  return mime === 'application/pdf' || mime === 'image/png' || mime === 'image/jpeg';
}

function bytesMatchDeclaredType(buffer: Buffer, mime: string): boolean {
  if (mime === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mime === 'image/png') {
    return buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function safeEvidenceFilename(originalName: string, mime: string): string {
  const extension = mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : '.jpg';
  const leaf = basename(originalName || `proof${extension}`)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(-120);
  return leaf || `proof${extension}`;
}

function bankInstructionsFor(locale: Locale): string {
  const variable =
    locale === Locale.AR
      ? 'KEMFAI_BANK_TRANSFER_INSTRUCTIONS_AR'
      : 'KEMFAI_BANK_TRANSFER_INSTRUCTIONS_EN';
  const instructions = process.env[variable]?.trim();
  if (!instructions) {
    throw new ServiceUnavailableException(
      `Bank transfer instructions are not configured for locale ${locale}`,
    );
  }
  return instructions;
}

function paymentReferenceFor(tenantId: string, subscription: Subscription): string {
  return `KEMFAI-${tenantId}-${subscription.id}-${subscription.currentPeriodStart}`;
}
