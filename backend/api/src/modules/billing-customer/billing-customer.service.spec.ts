import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import controlDataSource from '../../database/data-source';
import { MinioStorageService } from '../../integrations/minio/minio-storage.service';
import { Account } from '../accounts/entities/account.entity';
import { AuditService } from '../audit/audit.service';
import { Plan } from '../entitlements/entities/plan.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { BillingCustomerService } from './billing-customer.service';
import { PaymentSubmission, PaymentSubmissionStatus } from './entities/payment-submission.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from './entities/subscription.entity';

const SUBJECT_ID = '06200000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '06200000-0000-4000-8000-000000000002';
const TENANT_ID = '06200000-0000-4000-8000-000000000003';
const PLAN_ID = '06200000-0000-4000-8000-000000000004';
const SUBSCRIPTION_ID = '06200000-0000-4000-8000-000000000005';
const SUBMISSION_ID = '06200000-0000-4000-8000-000000000006';
const BUCKET = `kemfai-tenant-${TENANT_ID}`;

const account = { id: ACCOUNT_ID, keycloakUserId: SUBJECT_ID } as Account;
const tenant = {
  id: TENANT_ID,
  accountId: ACCOUNT_ID,
  minioBucket: BUCKET,
} as Tenant;
const subscription = {
  id: SUBSCRIPTION_ID,
  tenantId: TENANT_ID,
  planId: PLAN_ID,
  billingCycle: SubscriptionBillingCycle.MONTHLY,
  status: SubscriptionStatus.PENDING_ACTIVATION,
  currentPeriodStart: '2026-10-01',
  currentPeriodEnd: '2026-10-31',
} as Subscription;
const plan = {
  id: PLAN_ID,
  monthlyPrice: '1250.50',
  annualPrice: '12500.00',
  currency: 'AED',
} as Plan;

const validPdf = () => {
  const buffer = Buffer.from('%PDF-1.7\nT062 private proof fixture');
  return {
    originalname: 't062-private-proof.pdf',
    mimetype: 'application/pdf',
    size: buffer.length,
    buffer,
  };
};

describe('BillingCustomerService payment submissions (T062)', () => {
  let storage: {
    putObject: jest.Mock;
    removeObject: jest.Mock;
  };
  let audit: { recordBillingPaymentSubmissionCreated: jest.Mock };
  let service: BillingCustomerService;
  let paymentRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let transactionPaymentRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let transactionSubscriptionRepository: { findOne: jest.Mock };
  let transactionPlanRepository: { findOne: jest.Mock };
  let manager: { getRepository: jest.Mock };

  beforeEach(() => {
    storage = {
      putObject: jest.fn().mockResolvedValue(undefined),
      removeObject: jest.fn().mockResolvedValue(undefined),
    };
    audit = { recordBillingPaymentSubmissionCreated: jest.fn().mockResolvedValue(undefined) };
    paymentRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    transactionPaymentRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    };
    transactionSubscriptionRepository = {
      findOne: jest.fn().mockResolvedValue(subscription),
    };
    transactionPlanRepository = { findOne: jest.fn().mockResolvedValue(plan) };
    manager = {
      getRepository: jest.fn((target: unknown) => {
        if (target === PaymentSubmission) return transactionPaymentRepository;
        if (target === Subscription) return transactionSubscriptionRepository;
        if (target === Plan) return transactionPlanRepository;
        throw new Error(`Unexpected transaction repository: ${String(target)}`);
      }),
    };

    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: unknown) => {
      if (target === Account) return repositoryReturning(account) as never;
      if (target === Tenant) return repositoryReturning(tenant) as never;
      if (target === Subscription) return repositoryReturning(subscription) as never;
      if (target === Plan) return repositoryReturning(plan) as never;
      if (target === PaymentSubmission) return paymentRepository as never;
      throw new Error(`Unexpected repository: ${String(target)}`);
    });
    jest.spyOn(controlDataSource, 'transaction').mockImplementation((async (...args: unknown[]) => {
      const runInTransaction = args.at(-1) as (value: typeof manager) => Promise<unknown>;
      return runInTransaction(manager);
    }) as never);

    service = new BillingCustomerService(
      storage as unknown as MinioStorageService,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('rejects an unsupported type before any lookup, upload, or row transaction', async () => {
    const proof = {
      originalname: 't062-private-proof.txt',
      mimetype: 'text/plain',
      size: 20,
      buffer: Buffer.from('T062 private fixture'),
    };

    await expect(
      service.createPaymentSubmission(SUBJECT_ID, 'T062-BANK-REFERENCE', proof),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PAYMENT_PROOF_UNSUPPORTED_TYPE' }),
    });

    expect(controlDataSource.getRepository).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(controlDataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects an over-size file before any lookup, upload, or row transaction', async () => {
    const proof = validPdf();
    proof.size = 10 * 1024 * 1024 + 1;
    proof.buffer = Buffer.alloc(proof.size, 0x41);

    await expect(
      service.createPaymentSubmission(SUBJECT_ID, 'T062-BANK-REFERENCE', proof),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PAYMENT_PROOF_TOO_LARGE' }),
    });

    expect(controlDataSource.getRepository).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(controlDataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects a declared PDF whose bytes are unreadable before row creation', async () => {
    const proof = validPdf();
    proof.buffer = Buffer.from('not really a PDF');
    proof.size = proof.buffer.length;

    await expect(
      service.createPaymentSubmission(SUBJECT_ID, 'T062-BANK-REFERENCE', proof),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(storage.putObject).not.toHaveBeenCalled();
    expect(controlDataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects repeated multipart bankReference values as a controlled 422', async () => {
    await expect(
      service.createPaymentSubmission(
        SUBJECT_ID,
        ['T062-FIRST', 'T062-SECOND'] as unknown as string,
        validPdf(),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(controlDataSource.getRepository).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(controlDataSource.transaction).not.toHaveBeenCalled();
  });

  it('uploads valid proof, creates PendingReview with initial history, and audits in one DB transaction', async () => {
    transactionPaymentRepository.save.mockImplementation(async (row) => ({
      ...row,
      id: row.id ?? SUBMISSION_ID,
    }));

    const result = await service.createPaymentSubmission(
      SUBJECT_ID,
      ' T062-BANK-REFERENCE ',
      validPdf(),
    );

    const saved = transactionPaymentRepository.save.mock.calls[0][0] as PaymentSubmission;
    expect(saved).toMatchObject({
      tenantId: TENANT_ID,
      subscriptionId: SUBSCRIPTION_ID,
      billingPeriodStart: '2026-10-01',
      billingPeriodEnd: '2026-10-31',
      amount: '1250.50',
      currency: 'AED',
      bankReference: 'T062-BANK-REFERENCE',
      status: PaymentSubmissionStatus.PENDING_REVIEW,
    });
    expect(saved.statusHistory).toEqual([
      expect.objectContaining({
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        changedBy: ACCOUNT_ID,
        notes: null,
        bankReference: 'T062-BANK-REFERENCE',
        proofObjectKey: saved.proofObjectKey,
      }),
    ]);
    expect(storage.putObject).toHaveBeenCalledWith(
      BUCKET,
      saved.proofObjectKey,
      expect.any(Buffer),
      expect.objectContaining({ 'Content-Type': 'application/pdf' }),
    );
    expect(saved.proofObjectKey).toMatch(
      new RegExp(`^payment-submissions/${saved.id}/[0-9a-f-]+-t062-private-proof\\.pdf$`),
    );
    expect(audit.recordBillingPaymentSubmissionCreated).toHaveBeenCalledWith(
      {
        accountId: ACCOUNT_ID,
        tenantId: TENANT_ID,
        paymentSubmissionId: saved.id,
        bankReference: 'T062-BANK-REFERENCE',
        amount: '1250.50',
        currency: 'AED',
        billingPeriodStart: '2026-10-01',
        billingPeriodEnd: '2026-10-31',
        occurredAt: saved.submittedAt,
      },
      manager,
    );
    expect(result).toEqual({
      id: saved.id,
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      submittedAt: saved.submittedAt.toISOString(),
      statusHistory: saved.statusHistory,
    });
  });

  it('returns 409 for an existing PendingReview without uploading another object', async () => {
    paymentRepository.findOne.mockResolvedValue({
      id: SUBMISSION_ID,
      status: PaymentSubmissionStatus.PENDING_REVIEW,
    });

    await expect(
      service.createPaymentSubmission(SUBJECT_ID, 'T062-DUPLICATE', validPdf()),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(storage.putObject).not.toHaveBeenCalled();
    expect(controlDataSource.transaction).not.toHaveBeenCalled();
  });

  it('resubmits MoreInfoRequested on the same row and appends history without rewriting prior entries', async () => {
    const priorHistory = [
      {
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        changedAt: '2026-10-01T10:00:00.000Z',
        changedBy: ACCOUNT_ID,
        notes: null,
        bankReference: 'T062-OLD-REFERENCE',
        proofObjectKey: `payment-submissions/${SUBMISSION_ID}/old-proof.pdf`,
      },
      {
        status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
        changedAt: '2026-10-02T10:00:00.000Z',
        changedBy: '06200000-0000-4000-8000-000000000007',
        notes: 'Please provide a clearer receipt.',
      },
    ];
    const existing = {
      id: SUBMISSION_ID,
      tenantId: TENANT_ID,
      subscriptionId: SUBSCRIPTION_ID,
      billingPeriodStart: '2026-10-01',
      billingPeriodEnd: '2026-10-31',
      amount: '1250.50',
      currency: 'AED',
      bankReference: 'T062-OLD-REFERENCE',
      proofObjectKey: `payment-submissions/${SUBMISSION_ID}/old-proof.pdf`,
      status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
      submittedAt: new Date('2026-10-01T10:00:00.000Z'),
      reviewedBy: '06200000-0000-4000-8000-000000000007',
      reviewedAt: new Date('2026-10-02T10:00:00.000Z'),
      decisionNotes: 'Please provide a clearer receipt.',
      statusHistory: priorHistory,
    } as PaymentSubmission;
    paymentRepository.findOne.mockResolvedValue(existing);
    transactionPaymentRepository.findOne.mockResolvedValue(existing);

    const result = await service.createPaymentSubmission(
      SUBJECT_ID,
      'T062-NEW-REFERENCE',
      validPdf(),
    );

    const saved = transactionPaymentRepository.save.mock.calls[0][0] as PaymentSubmission;
    expect(saved.id).toBe(SUBMISSION_ID);
    expect(saved.status).toBe(PaymentSubmissionStatus.PENDING_REVIEW);
    expect(saved.bankReference).toBe('T062-NEW-REFERENCE');
    expect(saved.reviewedBy).toBeNull();
    expect(saved.reviewedAt).toBeNull();
    expect(saved.decisionNotes).toBeNull();
    expect(saved.statusHistory).toHaveLength(3);
    expect(saved.statusHistory.slice(0, 2)).toEqual(priorHistory);
    expect(saved.statusHistory[2]).toEqual(
      expect.objectContaining({
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        changedBy: ACCOUNT_ID,
        bankReference: 'T062-NEW-REFERENCE',
        proofObjectKey: saved.proofObjectKey,
      }),
    );
    expect(result.id).toBe(SUBMISSION_ID);
  });

  it('maps the DB unresolved-period race to 409 and removes the just-uploaded object', async () => {
    const driverError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'uq_payment_submission_unresolved_period',
    });
    transactionPaymentRepository.save.mockRejectedValue(
      new QueryFailedError('INSERT', [], driverError),
    );

    await expect(
      service.createPaymentSubmission(SUBJECT_ID, 'T062-RACE', validPdf()),
    ).rejects.toBeInstanceOf(ConflictException);

    const uploadedKey = storage.putObject.mock.calls[0][1] as string;
    expect(storage.removeObject).toHaveBeenCalledWith(BUCKET, uploadedKey);
    expect(audit.recordBillingPaymentSubmissionCreated).not.toHaveBeenCalled();
  });

  it('does not delete evidence when the transaction body succeeds but commit acknowledgement is lost', async () => {
    jest.spyOn(controlDataSource, 'transaction').mockRestore();
    jest.spyOn(controlDataSource, 'transaction').mockImplementation((async (...args: unknown[]) => {
      const runInTransaction = args.at(-1) as (value: typeof manager) => Promise<unknown>;
      await runInTransaction(manager);
      throw new Error('T062 simulated commit acknowledgement loss');
    }) as never);

    await expect(
      service.createPaymentSubmission(SUBJECT_ID, 'T062-AMBIGUOUS-COMMIT', validPdf()),
    ).rejects.toThrow('T062 simulated commit acknowledgement loss');

    expect(transactionPaymentRepository.save).toHaveBeenCalledTimes(1);
    expect(audit.recordBillingPaymentSubmissionCreated).toHaveBeenCalledTimes(1);
    expect(storage.removeObject).not.toHaveBeenCalled();
  });

  it('fails and compensates before insert when the locked subscription period changed', async () => {
    transactionSubscriptionRepository.findOne.mockResolvedValue({
      ...subscription,
      currentPeriodStart: '2026-11-01',
      currentPeriodEnd: '2026-11-30',
    });

    await expect(
      service.createPaymentSubmission(SUBJECT_ID, 'T062-STALE-PERIOD', validPdf()),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(transactionPaymentRepository.save).not.toHaveBeenCalled();
    expect(audit.recordBillingPaymentSubmissionCreated).not.toHaveBeenCalled();
    expect(storage.removeObject).toHaveBeenCalledTimes(1);
  });

  it('lists only the authenticated tenant submissions as contract views', async () => {
    paymentRepository.find.mockResolvedValue([
      {
        id: SUBMISSION_ID,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        submittedAt: new Date('2026-10-10T12:00:00.000Z'),
        statusHistory: [],
      },
    ]);

    await expect(service.getPaymentSubmissions(SUBJECT_ID)).resolves.toEqual([
      {
        id: SUBMISSION_ID,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        submittedAt: '2026-10-10T12:00:00.000Z',
        statusHistory: [],
      },
    ]);
    expect(paymentRepository.find).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID },
      order: { submittedAt: 'DESC' },
    });
  });
});

function repositoryReturning(value: unknown): { findOne: jest.Mock } {
  return { findOne: jest.fn().mockResolvedValue(value) };
}
