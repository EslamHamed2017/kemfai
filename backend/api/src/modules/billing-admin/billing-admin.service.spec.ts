import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { EntityManager } from 'typeorm';
import controlDataSource from '../../database/data-source';
import { MinioStorageService } from '../../integrations/minio/minio-storage.service';
import { Account } from '../accounts/entities/account.entity';
import { AuditService } from '../audit/audit.service';
import { billingDecisionNotificationJobId } from '../../common/queues/queue-names';
import {
  PaymentSubmission,
  PaymentSubmissionStatus,
} from '../billing-customer/entities/payment-submission.entity';
import { Subscription, SubscriptionStatus } from '../billing-customer/entities/subscription.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { BillingAdminService } from './billing-admin.service';

const SUBMISSION_ID = '69000000-0000-4000-8000-000000000001';
const SUBSCRIPTION_ID = '69000000-0000-4000-8000-000000000002';
const TENANT_ID = '69000000-0000-4000-8000-000000000003';
const CUSTOMER_ID = '69000000-0000-4000-8000-000000000004';
const PLAN_ID = '69000000-0000-4000-8000-000000000005';
const REVIEWER_ID = '69000000-0000-4000-8000-000000000006';
const REVIEWER_SUB = '69000000-0000-4000-8000-000000000007';
const PERIOD_START = '2026-11-01';
const PERIOD_END = '2026-11-30';

describe('BillingAdminService review queue (T068)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requests a stable oldest-first order when submission timestamps tie', async () => {
    const find = jest.fn().mockResolvedValue([]);
    jest.spyOn(controlDataSource, 'getRepository').mockReturnValue({ find } as never);
    const service = new BillingAdminService(
      {} as MinioStorageService,
      {} as AuditService,
      {} as Queue,
    );

    await service.getReviewQueue();

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        order: { submittedAt: 'ASC', id: 'ASC' },
      }),
    );
  });
});

describe('BillingAdminService approval (T069)', () => {
  const originalHistory = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-10-12T08:00:00.000Z',
      changedBy: CUSTOMER_ID,
      notes: null,
    },
  ];

  let paymentRepository: { findOne: jest.Mock; save: jest.Mock };
  let subscriptionRepository: { findOne: jest.Mock; save: jest.Mock };
  let tenantRepository: { findOne: jest.Mock };
  let accountRepository: { findOne: jest.Mock };
  let manager: { getRepository: jest.Mock };
  let audit: {
    recordBillingPaymentSubmissionDecided: jest.Mock;
    recordBillingSubscriptionActivated: jest.Mock;
  };
  let submission: PaymentSubmission;
  let subscription: Subscription;
  let service: BillingAdminService;

  beforeEach(() => {
    submission = {
      id: SUBMISSION_ID,
      tenantId: TENANT_ID,
      subscriptionId: SUBSCRIPTION_ID,
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      amount: '1250.50',
      currency: 'AED',
      bankReference: 'T069-OWNED-REFERENCE',
      proofObjectKey: 'payment-submissions/t069-owned/proof.pdf',
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      reviewedBy: null,
      reviewedAt: null,
      decisionNotes: null,
      statusHistory: originalHistory.map((entry) => ({ ...entry })),
    } as PaymentSubmission;
    subscription = {
      id: SUBSCRIPTION_ID,
      tenantId: TENANT_ID,
      planId: PLAN_ID,
      status: SubscriptionStatus.PENDING_ACTIVATION,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      activatedBy: null,
      activatedAt: null,
    } as Subscription;
    paymentRepository = {
      findOne: jest.fn().mockResolvedValue(submission),
      save: jest.fn(async (row: PaymentSubmission) => row),
    };
    subscriptionRepository = {
      findOne: jest.fn().mockResolvedValue(subscription),
      save: jest.fn(async (row: Subscription) => row),
    };
    tenantRepository = {
      findOne: jest.fn().mockResolvedValue({ id: TENANT_ID, accountId: CUSTOMER_ID }),
    };
    accountRepository = {
      findOne: jest.fn().mockResolvedValue({ id: REVIEWER_ID, keycloakUserId: REVIEWER_SUB }),
    };
    manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === PaymentSubmission) return paymentRepository;
        if (entity === Subscription) return subscriptionRepository;
        if (entity === Tenant) return tenantRepository;
        if (entity === Account) return accountRepository;
        throw new Error(`Unexpected T069 repository: ${String(entity)}`);
      }),
    };
    audit = {
      recordBillingPaymentSubmissionDecided: jest.fn().mockResolvedValue(undefined),
      recordBillingSubscriptionActivated: jest.fn().mockResolvedValue(undefined),
    };
    jest
      .spyOn(controlDataSource, 'transaction')
      .mockImplementation((async (
        callback: (transactionManager: EntityManager) => Promise<unknown>,
      ) => callback(manager as unknown as EntityManager)) as typeof controlDataSource.transaction);
    service = new BillingAdminService(
      {} as MinioStorageService,
      audit as unknown as AuditService,
      { add: jest.fn() } as unknown as Queue,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('approves and activates with both complete FR-009 events in the same transaction', async () => {
    const result = await service.approve(SUBMISSION_ID, REVIEWER_SUB);

    expect(accountRepository.findOne).not.toHaveBeenCalled();
    expect(paymentRepository.findOne).toHaveBeenCalledWith({
      where: { id: SUBMISSION_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(subscriptionRepository.findOne).toHaveBeenCalledWith({
      where: { id: SUBSCRIPTION_ID, tenantId: TENANT_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(paymentRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: PaymentSubmissionStatus.APPROVED,
        reviewedBy: null,
        decisionNotes: null,
        statusHistory: [
          originalHistory[0],
          expect.objectContaining({
            status: PaymentSubmissionStatus.APPROVED,
            changedBy: REVIEWER_SUB,
            notes: null,
          }),
        ],
      }),
    );
    expect(subscriptionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
        activatedBy: null,
      }),
    );

    const completeFields = {
      customer: CUSTOMER_ID,
      tenant: TENANT_ID,
      plan: PLAN_ID,
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      amount: '1250.50',
      currency: 'AED',
      bankReference: 'T069-OWNED-REFERENCE',
      proofDocumentReference: 'payment-submissions/t069-owned/proof.pdf',
      reviewedBy: REVIEWER_SUB,
      reviewedAt: expect.any(Date),
      activatedBy: REVIEWER_SUB,
      activatedAt: expect.any(Date),
      notes: null,
      statusHistory: expect.arrayContaining([
        expect.objectContaining({ status: PaymentSubmissionStatus.APPROVED }),
      ]),
    };
    expect(audit.recordBillingPaymentSubmissionDecided).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewerInternalUserId: REVIEWER_SUB,
        tenantId: TENANT_ID,
        paymentSubmissionId: SUBMISSION_ID,
        decision: 'approve',
        ...completeFields,
      }),
      manager,
    );
    expect(audit.recordBillingSubscriptionActivated).toHaveBeenCalledWith(
      expect.objectContaining({
        activatedByInternalUserId: REVIEWER_SUB,
        tenantId: TENANT_ID,
        subscriptionId: SUBSCRIPTION_ID,
        decision: 'approve',
        ...completeFields,
      }),
      manager,
    );
    expect(result).toEqual(
      expect.objectContaining({
        submissionId: SUBMISSION_ID,
        subscriptionId: SUBSCRIPTION_ID,
        status: SubscriptionStatus.ACTIVE,
      }),
    );
  });

  it('returns 409 before mutation when the matching tenant period is already active', async () => {
    subscription.status = SubscriptionStatus.ACTIVE;

    await expect(service.approve(SUBMISSION_ID, REVIEWER_SUB)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(paymentRepository.save).not.toHaveBeenCalled();
    expect(subscriptionRepository.save).not.toHaveBeenCalled();
    expect(audit.recordBillingPaymentSubmissionDecided).not.toHaveBeenCalled();
    expect(audit.recordBillingSubscriptionActivated).not.toHaveBeenCalled();
  });

  it('renews an active subscription from an earlier period onto the submitted period', async () => {
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.currentPeriodStart = '2026-10-01';
    subscription.currentPeriodEnd = '2026-10-31';

    const result = await service.approve(SUBMISSION_ID, REVIEWER_SUB);

    expect(subscriptionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
        activatedBy: null,
      }),
    );
    expect(result).toMatchObject({
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
    });
  });

  it('audits an authenticated internal subject that has no customer-account mirror', async () => {
    accountRepository.findOne.mockResolvedValue(null);

    await service.approve(SUBMISSION_ID, REVIEWER_SUB);

    expect(accountRepository.findOne).not.toHaveBeenCalled();
    expect(paymentRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewedBy: null,
        statusHistory: expect.arrayContaining([
          expect.objectContaining({ changedBy: REVIEWER_SUB }),
        ]),
      }),
    );
    expect(subscriptionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ activatedBy: null }),
    );
    expect(audit.recordBillingPaymentSubmissionDecided).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewerInternalUserId: REVIEWER_SUB,
        reviewedBy: REVIEWER_SUB,
      }),
      manager,
    );
    expect(audit.recordBillingSubscriptionActivated).toHaveBeenCalledWith(
      expect.objectContaining({
        activatedByInternalUserId: REVIEWER_SUB,
        activatedBy: REVIEWER_SUB,
      }),
      manager,
    );
  });

  it('preserves the internal subject when its UUID collides with a customer identity', async () => {
    accountRepository.findOne.mockResolvedValue({
      id: CUSTOMER_ID,
      keycloakUserId: REVIEWER_SUB,
    });

    await service.approve(SUBMISSION_ID, REVIEWER_SUB);

    expect(accountRepository.findOne).not.toHaveBeenCalled();
    expect(paymentRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewedBy: null,
        statusHistory: expect.arrayContaining([
          expect.objectContaining({ changedBy: REVIEWER_SUB }),
        ]),
      }),
    );
    expect(subscriptionRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ activatedBy: null }),
    );
    expect(audit.recordBillingPaymentSubmissionDecided).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewerInternalUserId: REVIEWER_SUB,
        reviewedBy: REVIEWER_SUB,
      }),
      manager,
    );
    expect(audit.recordBillingSubscriptionActivated).toHaveBeenCalledWith(
      expect.objectContaining({
        activatedByInternalUserId: REVIEWER_SUB,
        activatedBy: REVIEWER_SUB,
      }),
      manager,
    );
  });
});

describe('BillingAdminService decisions (T070)', () => {
  const REJECT_REASON = 'Amount does not match the amount due.';
  const MORE_INFO_DETAILS = 'Please provide the bank confirmation number.';
  const originalHistory = [
    {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-11-12T08:00:00.000Z',
      changedBy: CUSTOMER_ID,
      notes: null,
    },
  ];

  let paymentRepository: { findOne: jest.Mock; save: jest.Mock };
  let subscriptionRepository: { findOne: jest.Mock; save: jest.Mock };
  let tenantRepository: { findOne: jest.Mock };
  let manager: { getRepository: jest.Mock };
  let audit: { recordBillingPaymentSubmissionDecided: jest.Mock };
  let notificationQueue: { add: jest.Mock };
  let submission: PaymentSubmission;
  let service: BillingAdminService;

  beforeEach(() => {
    submission = {
      id: SUBMISSION_ID,
      tenantId: TENANT_ID,
      subscriptionId: SUBSCRIPTION_ID,
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      amount: '1250.50',
      currency: 'AED',
      bankReference: 'T070-OWNED-REFERENCE',
      proofObjectKey: 'payment-submissions/t070-owned/proof.pdf',
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      reviewedBy: null,
      reviewedAt: null,
      decisionNotes: null,
      statusHistory: originalHistory.map((entry) => ({ ...entry })),
    } as PaymentSubmission;
    paymentRepository = {
      findOne: jest.fn().mockResolvedValue(submission),
      save: jest.fn(async (row: PaymentSubmission) => row),
    };
    subscriptionRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: SUBSCRIPTION_ID,
        tenantId: TENANT_ID,
        planId: PLAN_ID,
        status: SubscriptionStatus.PENDING_ACTIVATION,
      }),
      save: jest.fn(),
    };
    tenantRepository = {
      findOne: jest.fn().mockResolvedValue({ id: TENANT_ID, accountId: CUSTOMER_ID }),
    };
    manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === PaymentSubmission) return paymentRepository;
        if (entity === Subscription) return subscriptionRepository;
        if (entity === Tenant) return tenantRepository;
        throw new Error(`Unexpected T070 repository: ${String(entity)}`);
      }),
    };
    audit = {
      recordBillingPaymentSubmissionDecided: jest.fn().mockResolvedValue(undefined),
    };
    notificationQueue = { add: jest.fn().mockResolvedValue(undefined) };
    jest
      .spyOn(controlDataSource, 'transaction')
      .mockImplementation((async (
        callback: (transactionManager: EntityManager) => Promise<unknown>,
      ) => callback(manager as unknown as EntityManager)) as typeof controlDataSource.transaction);
    service = new BillingAdminService(
      {} as MinioStorageService,
      audit as unknown as AuditService,
      notificationQueue as unknown as Queue,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects atomically with full FR-009 audit and no activation, then notifies', async () => {
    const result = await service.reject(SUBMISSION_ID, REVIEWER_SUB, REJECT_REASON);

    expect(paymentRepository.findOne).toHaveBeenCalledWith({
      where: { id: SUBMISSION_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(paymentRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: PaymentSubmissionStatus.REJECTED,
        reviewedBy: null,
        decisionNotes: REJECT_REASON,
        statusHistory: [
          originalHistory[0],
          expect.objectContaining({
            status: PaymentSubmissionStatus.REJECTED,
            changedBy: REVIEWER_SUB,
            notes: REJECT_REASON,
          }),
        ],
      }),
    );
    // Scenario 6.3: the subscription remains unactivated — it is never written.
    expect(subscriptionRepository.save).not.toHaveBeenCalled();

    expect(audit.recordBillingPaymentSubmissionDecided).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewerInternalUserId: REVIEWER_SUB,
        tenantId: TENANT_ID,
        paymentSubmissionId: SUBMISSION_ID,
        decision: 'reject',
        customer: CUSTOMER_ID,
        tenant: TENANT_ID,
        plan: PLAN_ID,
        billingPeriodStart: PERIOD_START,
        billingPeriodEnd: PERIOD_END,
        amount: '1250.50',
        currency: 'AED',
        bankReference: 'T070-OWNED-REFERENCE',
        proofDocumentReference: 'payment-submissions/t070-owned/proof.pdf',
        reviewedBy: REVIEWER_SUB,
        reviewedAt: expect.any(Date),
        activatedBy: null,
        activatedAt: null,
        notes: REJECT_REASON,
        statusHistory: expect.arrayContaining([
          expect.objectContaining({ status: PaymentSubmissionStatus.REJECTED }),
        ]),
      }),
      manager,
    );

    expect(notificationQueue.add).toHaveBeenCalledWith(
      'notify',
      expect.objectContaining({
        submissionId: SUBMISSION_ID,
        tenantId: TENANT_ID,
        decision: 'reject',
        notes: REJECT_REASON,
      }),
      { jobId: billingDecisionNotificationJobId(SUBMISSION_ID, 'reject') },
    );
    expect(result).toEqual({
      submissionId: SUBMISSION_ID,
      status: PaymentSubmissionStatus.REJECTED,
      decision: 'reject',
      decisionNotes: REJECT_REASON,
      decidedAt: expect.any(String),
    });
  });

  it('requests more information with a customer-actionable status and latest-notes view', async () => {
    const result = await service.requestMoreInfo(SUBMISSION_ID, REVIEWER_SUB, MORE_INFO_DETAILS);

    expect(paymentRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
        reviewedBy: null,
        decisionNotes: MORE_INFO_DETAILS,
        statusHistory: [
          originalHistory[0],
          expect.objectContaining({
            status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
            changedBy: REVIEWER_SUB,
            notes: MORE_INFO_DETAILS,
          }),
        ],
      }),
    );
    expect(subscriptionRepository.save).not.toHaveBeenCalled();
    expect(audit.recordBillingPaymentSubmissionDecided).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'more_info',
        activatedBy: null,
        activatedAt: null,
        notes: MORE_INFO_DETAILS,
      }),
      manager,
    );
    expect(notificationQueue.add).toHaveBeenCalledWith(
      'notify',
      expect.objectContaining({ decision: 'more_info', notes: MORE_INFO_DETAILS }),
      { jobId: billingDecisionNotificationJobId(SUBMISSION_ID, 'more_info') },
    );
    expect(result).toMatchObject({
      submissionId: SUBMISSION_ID,
      status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
      decision: 'more_info',
      decisionNotes: MORE_INFO_DETAILS,
    });
  });

  it('trims surrounding whitespace from notes before persisting them', async () => {
    await service.reject(SUBMISSION_ID, REVIEWER_SUB, `  ${REJECT_REASON}  `);

    expect(paymentRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ decisionNotes: REJECT_REASON }),
    );
    expect(audit.recordBillingPaymentSubmissionDecided).toHaveBeenCalledWith(
      expect.objectContaining({ notes: REJECT_REASON }),
      manager,
    );
  });

  it('rejects blank notes with 422 before touching the database', async () => {
    await expect(service.reject(SUBMISSION_ID, REVIEWER_SUB, '   ')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(service.requestMoreInfo(SUBMISSION_ID, REVIEWER_SUB, '')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    expect(paymentRepository.findOne).not.toHaveBeenCalled();
    expect(paymentRepository.save).not.toHaveBeenCalled();
    expect(audit.recordBillingPaymentSubmissionDecided).not.toHaveBeenCalled();
    expect(notificationQueue.add).not.toHaveBeenCalled();
  });

  it('answers 404 when the submission does not exist', async () => {
    paymentRepository.findOne.mockResolvedValue(null);

    await expect(service.reject(SUBMISSION_ID, REVIEWER_SUB, REJECT_REASON)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.requestMoreInfo(SUBMISSION_ID, REVIEWER_SUB, MORE_INFO_DETAILS),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(notificationQueue.add).not.toHaveBeenCalled();
  });

  it.each([
    ['Approved', PaymentSubmissionStatus.APPROVED],
    ['Rejected', PaymentSubmissionStatus.REJECTED],
    ['MoreInfoRequested', PaymentSubmissionStatus.MORE_INFO_REQUESTED],
  ])(
    'answers 409 with no mutation, audit, or notification when the submission is %s',
    async (_label, status) => {
      submission.status = status;

      await expect(
        service.reject(SUBMISSION_ID, REVIEWER_SUB, REJECT_REASON),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.requestMoreInfo(SUBMISSION_ID, REVIEWER_SUB, MORE_INFO_DETAILS),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(paymentRepository.save).not.toHaveBeenCalled();
      expect(audit.recordBillingPaymentSubmissionDecided).not.toHaveBeenCalled();
      expect(notificationQueue.add).not.toHaveBeenCalled();
    },
  );

  it('never enqueues the notification when the decision transaction fails', async () => {
    paymentRepository.findOne.mockRejectedValue(new Error('lock acquisition failed'));

    await expect(service.reject(SUBMISSION_ID, REVIEWER_SUB, REJECT_REASON)).rejects.toThrow(
      'lock acquisition failed',
    );
    expect(notificationQueue.add).not.toHaveBeenCalled();
  });

  it('keeps the decided response successful when the enqueue fails (events.md: retried, non-blocking)', async () => {
    notificationQueue.add.mockRejectedValue(new Error('redis unavailable'));

    const result = await service.requestMoreInfo(SUBMISSION_ID, REVIEWER_SUB, MORE_INFO_DETAILS);

    expect(result).toMatchObject({ status: PaymentSubmissionStatus.MORE_INFO_REQUESTED });
    expect(audit.recordBillingPaymentSubmissionDecided).toHaveBeenCalledWith(
      expect.anything(),
      manager,
    );
  });
});
