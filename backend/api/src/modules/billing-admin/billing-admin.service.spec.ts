import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { EntityManager } from 'typeorm';
import controlDataSource from '../../database/data-source';
import { MinioStorageService } from '../../integrations/minio/minio-storage.service';
import { Account } from '../accounts/entities/account.entity';
import { AuditService } from '../audit/audit.service';
import {
  BILLING_DECISION_NOTIFICATION_ATTEMPTS,
  BILLING_DECISION_NOTIFICATION_BACKOFF,
  billingDecisionNotificationJobId,
} from '../../common/queues/queue-names';
import {
  BillingDecisionNotificationOutboxRow,
  BillingDecisionNotificationOutboxService,
} from './billing-decision-notification-outbox.service';
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

/** The outbox collaborator every BillingAdminService construction site needs (T070 durability). */
function makeOutboxService() {
  const markEnqueued = jest.fn().mockResolvedValue(undefined);
  return {
    // Returns a row derived from the recorded input, so the post-commit dispatch
    // carries the real decision's data through to queue.add.
    recordPending: jest.fn(
      async (
        _manager: unknown,
        input: {
          submissionId: string;
          tenantId: string;
          decision: string;
          notes: string | null;
          occurredAt: Date;
          jobId: string;
        },
      ) =>
        ({
          id: 'outbox-1',
          ...input,
          state: 'pending',
          retryCount: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
        }) as BillingDecisionNotificationOutboxRow,
    ),
    markEnqueued,
    // Faithful stand-in for the real dispatch: enqueue with the occurrence job id and
    // the events.md retry options, then mark — so the service-under-test's real call
    // path (delegating to the outbox) still exercises queue.add + markEnqueued.
    dispatch: jest.fn(
      async (outboxRow: BillingDecisionNotificationOutboxRow, queue: { add: jest.Mock }) => {
        await queue.add(
          'notify',
          {
            submissionId: outboxRow.submissionId,
            tenantId: outboxRow.tenantId,
            decision: outboxRow.decision,
            notes: outboxRow.notes,
            occurredAt: outboxRow.occurredAt.toISOString(),
          },
          {
            jobId: outboxRow.jobId,
            attempts: BILLING_DECISION_NOTIFICATION_ATTEMPTS,
            backoff: BILLING_DECISION_NOTIFICATION_BACKOFF,
          },
        );
        await markEnqueued(outboxRow.id);
      },
    ),
  } as unknown as BillingDecisionNotificationOutboxService;
}

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
      makeOutboxService(),
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
  let notificationQueue: { add: jest.Mock };
  let outbox: ReturnType<typeof makeOutboxService>;
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
    notificationQueue = { add: jest.fn().mockResolvedValue(undefined) };
    outbox = makeOutboxService();
    jest
      .spyOn(controlDataSource, 'transaction')
      .mockImplementation((async (
        callback: (transactionManager: EntityManager) => Promise<unknown>,
      ) => callback(manager as unknown as EntityManager)) as typeof controlDataSource.transaction);
    service = new BillingAdminService(
      {} as MinioStorageService,
      audit as unknown as AuditService,
      notificationQueue as unknown as Queue,
      outbox,
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
    // FR-035 (reviewer finding 3): approvals notify too. The outbox row is committed
    // inside the SAME transaction as the activation (atomicity preserved), and the
    // enqueue happens only after it resolves.
    expect(outbox.recordPending).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        submissionId: SUBMISSION_ID,
        tenantId: TENANT_ID,
        decision: 'approve',
        notes: null,
        jobId: billingDecisionNotificationJobId(SUBMISSION_ID, 'approve', 1),
        occurredAt: expect.any(Date),
      }),
    );
    expect(notificationQueue.add).toHaveBeenCalledWith(
      'notify',
      expect.objectContaining({
        submissionId: SUBMISSION_ID,
        tenantId: TENANT_ID,
        decision: 'approve',
        notes: null,
      }),
      {
        jobId: billingDecisionNotificationJobId(SUBMISSION_ID, 'approve', 1),
        attempts: BILLING_DECISION_NOTIFICATION_ATTEMPTS,
        backoff: BILLING_DECISION_NOTIFICATION_BACKOFF,
      },
    );
    expect(outbox.markEnqueued).toHaveBeenCalledWith('outbox-1');
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
    expect(outbox.recordPending).not.toHaveBeenCalled();
    expect(notificationQueue.add).not.toHaveBeenCalled();
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
  let outbox: ReturnType<typeof makeOutboxService>;
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
    outbox = makeOutboxService();
    jest
      .spyOn(controlDataSource, 'transaction')
      .mockImplementation((async (
        callback: (transactionManager: EntityManager) => Promise<unknown>,
      ) => callback(manager as unknown as EntityManager)) as typeof controlDataSource.transaction);
    service = new BillingAdminService(
      {} as MinioStorageService,
      audit as unknown as AuditService,
      notificationQueue as unknown as Queue,
      outbox,
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

    // T070 durability (reviewer finding 1): the pending-notification outbox row is
    // committed INSIDE the decision transaction via the same manager — commit or roll
    // back together — keyed by the decision occurrence's status_history index.
    expect(outbox.recordPending).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        submissionId: SUBMISSION_ID,
        tenantId: TENANT_ID,
        decision: 'reject',
        notes: REJECT_REASON,
        jobId: billingDecisionNotificationJobId(SUBMISSION_ID, 'reject', 1),
        occurredAt: expect.any(Date),
      }),
    );

    expect(notificationQueue.add).toHaveBeenCalledWith(
      'notify',
      expect.objectContaining({
        submissionId: SUBMISSION_ID,
        tenantId: TENANT_ID,
        decision: 'reject',
        notes: REJECT_REASON,
      }),
      {
        jobId: billingDecisionNotificationJobId(SUBMISSION_ID, 'reject', 1),
        attempts: BILLING_DECISION_NOTIFICATION_ATTEMPTS,
        backoff: BILLING_DECISION_NOTIFICATION_BACKOFF,
      },
    );
    expect(outbox.markEnqueued).toHaveBeenCalledWith('outbox-1');
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
      {
        jobId: billingDecisionNotificationJobId(SUBMISSION_ID, 'more_info', 1),
        attempts: BILLING_DECISION_NOTIFICATION_ATTEMPTS,
        backoff: BILLING_DECISION_NOTIFICATION_BACKOFF,
      },
    );
    expect(result).toMatchObject({
      submissionId: SUBMISSION_ID,
      status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
      decision: 'more_info',
      decisionNotes: MORE_INFO_DETAILS,
    });
  });

  it('enqueues a distinct occurrence-keyed job for a repeated more-info cycle carrying the latest notes', async () => {
    // Reviewer finding 2: the submission row already carries one completed more-info/
    // resubmission cycle, and a prior BullMQ job may still exist under the FIRST
    // cycle's key. The new decision must produce its own job keyed by its own
    // status_history occurrence, with the latest notes.
    const priorCycleHistory = [
      ...originalHistory,
      {
        status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
        changedAt: '2026-11-13T08:00:00.000Z',
        changedBy: REVIEWER_SUB,
        notes: 'First request.',
      },
      {
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        changedAt: '2026-11-14T08:00:00.000Z',
        changedBy: CUSTOMER_ID,
        notes: null,
      },
    ];
    submission.statusHistory = priorCycleHistory.map((entry) => ({ ...entry }));

    await service.requestMoreInfo(SUBMISSION_ID, REVIEWER_SUB, MORE_INFO_DETAILS);

    expect(outbox.recordPending).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        decision: 'more_info',
        notes: MORE_INFO_DETAILS,
        jobId: billingDecisionNotificationJobId(SUBMISSION_ID, 'more_info', 3),
      }),
    );
    expect(notificationQueue.add).toHaveBeenCalledWith(
      'notify',
      expect.objectContaining({ decision: 'more_info', notes: MORE_INFO_DETAILS }),
      expect.objectContaining({
        jobId: billingDecisionNotificationJobId(SUBMISSION_ID, 'more_info', 3),
      }),
    );
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

  it('never enqueues the notification when the in-transaction audit append fails', async () => {
    audit.recordBillingPaymentSubmissionDecided.mockRejectedValue(new Error('audit store down'));

    await expect(
      service.requestMoreInfo(SUBMISSION_ID, REVIEWER_SUB, MORE_INFO_DETAILS),
    ).rejects.toThrow('audit store down');

    // The audit failure aborts the whole decision transaction — the notification must
    // never be dispatched for a decision that did not durably commit.
    expect(notificationQueue.add).not.toHaveBeenCalled();
    expect(outbox.markEnqueued).not.toHaveBeenCalled();
  });

  it('keeps the decided response successful when the enqueue fails, leaving the outbox row pending for recovery (events.md: retried, non-blocking)', async () => {
    notificationQueue.add.mockRejectedValue(new Error('redis unavailable'));

    const result = await service.requestMoreInfo(SUBMISSION_ID, REVIEWER_SUB, MORE_INFO_DETAILS);

    expect(result).toMatchObject({ status: PaymentSubmissionStatus.MORE_INFO_REQUESTED });
    expect(audit.recordBillingPaymentSubmissionDecided).toHaveBeenCalledWith(
      expect.anything(),
      manager,
    );
    // Reviewer finding 1: a Redis-add failure must leave a persisted, recoverable
    // pending row — the row is committed with the decision, and only a successful
    // add() may transition it to enqueued.
    expect(outbox.recordPending).toHaveBeenCalledWith(manager, expect.anything());
    expect(outbox.markEnqueued).not.toHaveBeenCalled();
  });
});
