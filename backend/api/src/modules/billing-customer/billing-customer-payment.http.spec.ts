import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import controlDataSource from '../../database/data-source';
import { MinioStorageService } from '../../integrations/minio/minio-storage.service';
import { Account } from '../accounts/entities/account.entity';
import { AuditService } from '../audit/audit.service';
import { Plan } from '../entitlements/entities/plan.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { BillingCustomerModule } from './billing-customer.module';
import { PaymentSubmission, PaymentSubmissionStatus } from './entities/payment-submission.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from './entities/subscription.entity';

const SUBJECT_ID = '06210000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '06210000-0000-4000-8000-000000000002';
const TENANT_ID = '06210000-0000-4000-8000-000000000003';
const PLAN_ID = '06210000-0000-4000-8000-000000000004';
const SUBSCRIPTION_ID = '06210000-0000-4000-8000-000000000005';
const BUCKET = `kemfai-tenant-${TENANT_ID}`;

/**
 * T062 HTTP adapter proof. This uses the real Nest controller, multipart interceptor,
 * exception filter, and service with label-owned in-memory repository/storage fakes.
 * It intentionally does not claim a live PostgreSQL or MinIO integration.
 */
describe('GET/POST /billing/payment-submissions HTTP adapter (T062)', () => {
  let app: INestApplication;
  let storedSubmission: PaymentSubmission | null;
  let storage: { putObject: jest.Mock; removeObject: jest.Mock };
  let audit: { recordBillingPaymentSubmissionCreated: jest.Mock };
  let transaction: jest.SpyInstance;

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
    monthlyPrice: '1250.00',
    annualPrice: '12500.00',
    currency: 'AED',
  } as Plan;

  beforeAll(async () => {
    storage = {
      putObject: jest.fn().mockResolvedValue(undefined),
      removeObject: jest.fn().mockResolvedValue(undefined),
    };
    audit = { recordBillingPaymentSubmissionCreated: jest.fn().mockResolvedValue(undefined) };

    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: unknown) => {
      if (target === Account) return repositoryReturning(account) as never;
      if (target === Tenant) return repositoryReturning(tenant) as never;
      if (target === Subscription) return repositoryReturning(subscription) as never;
      if (target === Plan) return repositoryReturning(plan) as never;
      if (target === PaymentSubmission) {
        return {
          findOne: jest.fn(async () => storedSubmission),
          find: jest.fn(async () => (storedSubmission ? [storedSubmission] : [])),
        } as never;
      }
      throw new Error(`Unexpected repository: ${String(target)}`);
    });

    const transactionRepository = {
      findOne: jest.fn(async () => storedSubmission),
      create: jest.fn((value) => value),
      save: jest.fn(async (value: PaymentSubmission) => {
        storedSubmission = value;
        return value;
      }),
    };
    const manager = {
      getRepository: jest.fn((target: unknown) => {
        if (target === PaymentSubmission) return transactionRepository;
        if (target === Subscription) return repositoryReturning(subscription);
        if (target === Plan) return repositoryReturning(plan);
        throw new Error(`Unexpected transaction repository: ${String(target)}`);
      }),
    };
    transaction = jest.spyOn(controlDataSource, 'transaction').mockImplementation((async (
      ...args: unknown[]
    ) => {
      const runInTransaction = args.at(-1) as (value: typeof manager) => Promise<unknown>;
      return runInTransaction(manager);
    }) as never);

    const moduleRef = await Test.createTestingModule({ imports: [BillingCustomerModule] })
      .overrideProvider(MinioStorageService)
      .useValue(storage)
      .overrideProvider(AuditService)
      .useValue(audit)
      .compile();

    app = moduleRef.createNestApplication();
    app.use((req: { auth?: unknown }, _res: unknown, next: () => void) => {
      req.auth = { keycloakUserId: SUBJECT_ID, roles: ['WorkspaceOwner'], tenantId: TENANT_ID };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    storedSubmission = null;
    storage.putObject.mockClear();
    storage.removeObject.mockClear();
    audit.recordBillingPaymentSubmissionCreated.mockClear();
    transaction.mockClear();
  });

  it('accepts multipart PDF proof as 201 and exposes the tenant-scoped submission via GET', async () => {
    const created = await request(app.getHttpServer())
      .post('/billing/payment-submissions')
      .field('bankReference', 'T062-HTTP-PRIVATE-REFERENCE')
      .attach('proofFile', Buffer.from('%PDF-1.7\nT062 private HTTP fixture'), {
        filename: 't062-private-http-proof.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(created.body).toMatchObject({
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      statusHistory: [
        expect.objectContaining({
          status: PaymentSubmissionStatus.PENDING_REVIEW,
          bankReference: 'T062-HTTP-PRIVATE-REFERENCE',
        }),
      ],
    });
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    expect(audit.recordBillingPaymentSubmissionCreated).toHaveBeenCalledTimes(1);

    const listed = await request(app.getHttpServer())
      .get('/billing/payment-submissions')
      .expect(200);
    expect(listed.body).toEqual([created.body]);
  });

  it('returns typed 422 for an unsupported multipart proof before any transaction', async () => {
    const response = await request(app.getHttpServer())
      .post('/billing/payment-submissions')
      .field('bankReference', 'T062-HTTP-UNSUPPORTED')
      .attach('proofFile', Buffer.from('T062 private text fixture'), {
        filename: 't062-private-proof.txt',
        contentType: 'text/plain',
      })
      .expect(422);

    expect(response.body).toMatchObject({ code: 'PAYMENT_PROOF_UNSUPPORTED_TYPE' });
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('maps Multer size rejection to the contract 422 before service persistence', async () => {
    const response = await request(app.getHttpServer())
      .post('/billing/payment-submissions')
      .field('bankReference', 'T062-HTTP-OVERSIZE')
      .attach('proofFile', Buffer.alloc(10 * 1024 * 1024 + 1, 0x41), {
        filename: 't062-private-oversize.pdf',
        contentType: 'application/pdf',
      })
      .expect(422);

    expect(response.body).toMatchObject({ code: 'PAYMENT_PROOF_TOO_LARGE' });
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('returns a controlled 422 for repeated bankReference multipart fields', async () => {
    const response = await request(app.getHttpServer())
      .post('/billing/payment-submissions')
      .field('bankReference', 'T062-FIRST-REFERENCE')
      .field('bankReference', 'T062-SECOND-REFERENCE')
      .attach('proofFile', Buffer.from('%PDF-1.7\nT062 repeated-field fixture'), {
        filename: 't062-private-repeated-field.pdf',
        contentType: 'application/pdf',
      })
      .expect(422);

    expect(response.body).toMatchObject({ code: 'PAYMENT_BANK_REFERENCE_REQUIRED' });
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('returns 409 for a second PendingReview request without a second proof upload', async () => {
    const post = () =>
      request(app.getHttpServer())
        .post('/billing/payment-submissions')
        .field('bankReference', 'T062-DUPLICATE-REFERENCE')
        .attach('proofFile', Buffer.from('%PDF-1.7\nT062 duplicate fixture'), {
          filename: 't062-private-duplicate.pdf',
          contentType: 'application/pdf',
        });

    await post().expect(201);
    const duplicate = await post().expect(409);

    expect(duplicate.body).toMatchObject({
      code: 'PAYMENT_SUBMISSION_UNRESOLVED_DUPLICATE',
    });
    expect(storage.putObject).toHaveBeenCalledTimes(1);
  });
});

function repositoryReturning(value: unknown): { findOne: jest.Mock } {
  return { findOne: jest.fn().mockResolvedValue(value) };
}
