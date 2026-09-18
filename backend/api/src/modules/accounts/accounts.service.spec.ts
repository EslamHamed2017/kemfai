import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import controlDataSource from '../../database/data-source';
import { AuditService } from '../audit/audit.service';
import { Plan } from '../entitlements/entities/plan.entity';
import { Account, BillingCycle } from './entities/account.entity';
import { EmailVerificationToken } from './entities/email-verification-token.entity';
import { AccountsService } from './accounts.service';
import { SignupRequestDto } from './dto/signup.request.dto';
import { hashVerificationToken } from './tokens/email-verification-token';
import {
  KeycloakUserConflictError,
  KeycloakUnavailableError,
} from '../../integrations/keycloak/keycloak-user-provisioner';

/**
 * Unit coverage of the T032 signup saga's ordering, revalidation, and compensation rules
 * (review findings 2026-09-19 00:37 + 00:57) and of the T033 verify-email saga's
 * validation/atomicity/compensation rules, with stubbed repositories/queues/provisioner.
 * DB-level proof (unique email constraint as the idempotency anchor, audit rows, BullMQ
 * job ids, latest-link-wins) lives in test/integration/accounts-*.integration-spec.ts.
 */

const PLAN_ID = '11111111-1111-4111-8111-111111111111';
const KNOWN_PLANS = new Set([PLAN_ID, '22222222-2222-4222-8222-222222222222']);

function makeDto(overrides: Partial<SignupRequestDto> = {}): SignupRequestDto {
  return Object.assign(
    {
      email: 'Owner@Example.com',
      password: 'a-very-strong-password',
      planId: PLAN_ID,
      billingCycle: BillingCycle.MONTHLY,
      acceptedTerms: true,
    } satisfies SignupRequestDto,
    overrides,
  );
}

describe('AccountsService.signup (T032, unit)', () => {
  let accountRepo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let planRepo: { findOne: jest.Mock };
  let createUser: jest.Mock;
  let deleteUser: jest.Mock;
  let markEmailVerified: jest.Mock;
  let recordAccountCreated: jest.Mock;
  let queueAdd: jest.Mock;
  let insertShouldCollide: boolean;
  let existingAccount: Account | null;

  beforeEach(() => {
    insertShouldCollide = false;
    existingAccount = null;
    createUser = jest.fn().mockResolvedValue(undefined);
    deleteUser = jest.fn().mockResolvedValue(undefined);
    markEmailVerified = jest.fn().mockResolvedValue(undefined);
    recordAccountCreated = jest.fn().mockResolvedValue(undefined);
    queueAdd = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeService(): AccountsService {
    let createdCounter = 0;
    accountRepo = {
      create: jest.fn((values: Partial<Account>) => {
        createdCounter += 1;
        return { ...values, id: `generated-id-${createdCounter}` } as Account;
      }),
      save: jest.fn(async (account: Account) => {
        if (insertShouldCollide) {
          const error = new Error('duplicate key value violates unique constraint') as Error & {
            code: string;
          };
          error.code = '23505';
          throw error;
        }
        return account;
      }),
      findOne: jest.fn().mockImplementation(async () => existingAccount),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    planRepo = {
      findOne: jest
        .fn()
        .mockImplementation(async ({ where }: { where: { id: string; published: boolean } }) =>
          KNOWN_PLANS.has(where.id) && where.published === true ? { id: where.id } : null,
        ),
    };
    const tokenRepo = { insert: jest.fn().mockResolvedValue(undefined) };

    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: any) => {
      if (target === Plan) {
        return planRepo as any;
      }
      if (target === Account) {
        return accountRepo as any;
      }
      if (target === EmailVerificationToken) {
        return tokenRepo as any;
      }
      throw new Error(`Unexpected repository requested for ${String(target)}`);
    });

    const audit = { recordAccountCreated } as unknown as AuditService;
    const queue = { add: queueAdd } as unknown as Queue;
    const tenantQueue = { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue;
    const provisioner = { createUser, deleteUser, markEmailVerified };
    return new AccountsService(audit, queue, tenantQueue, provisioner as never);
  }

  function makeExistingAccount(overrides: Partial<Account> = {}): Account {
    return {
      id: 'existing-account-id',
      keycloakUserId: 'existing-kc-user-id',
      email: 'owner@example.com',
      emailVerified: false,
      mfaEnrolled: false,
      selectedPlanId: PLAN_ID,
      selectedBillingCycle: BillingCycle.MONTHLY,
      preferredLocale: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as Account;
  }

  it('happy path: creates the row, the Keycloak user, the audit event, then the email job, in that order', async () => {
    const service = makeService();
    const result = await service.signup(makeDto());

    expect(result).toEqual({ accountId: 'generated-id-1' });
    expect(accountRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'owner@example.com', // normalized: trimmed + lowercased
        emailVerified: false,
        mfaEnrolled: false,
        selectedPlanId: PLAN_ID,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
    );

    expect(createUser).toHaveBeenCalledWith({
      id: expect.any(String),
      email: 'owner@example.com',
      password: 'a-very-strong-password',
      requiredActions: ['VERIFY_EMAIL'],
    });
    expect(recordAccountCreated).toHaveBeenCalledWith({
      accountId: 'generated-id-1',
      planId: PLAN_ID,
      billingCycle: BillingCycle.MONTHLY,
    });
    expect(queueAdd).toHaveBeenCalledTimes(1);
    const [jobName, payload, options] = queueAdd.mock.calls[0] as [
      string,
      { accountId: string; tokenVersion: string; token: string },
      { jobId: string },
    ];
    expect(jobName).toBe('send');
    expect(payload.accountId).toBe('generated-id-1');
    expect(typeof payload.token).toBe('string'); // raw link bearer rides the job, never the DB
    expect(options.jobId).toBe(`${payload.accountId}.${payload.tokenVersion}`);

    // Compensation-critical ordering: Keycloak user -> audit -> queue, all after the row.
    const saveOrder = accountRepo.save.mock.invocationCallOrder[0];
    const order = [
      saveOrder,
      createUser.mock.invocationCallOrder[0],
      recordAccountCreated.mock.invocationCallOrder[0],
      queueAdd.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('rejects an unpublished/missing plan with 422 BEFORE any side effect, for new emails', async () => {
    const service = makeService();
    await expect(
      service.signup(makeDto({ planId: '33333333-3333-4333-8333-333333333333' })),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(accountRepo.save).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
    expect(recordAccountCreated).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('verified duplicate: generic 409, no second row, no Keycloak/audit/email work', async () => {
    insertShouldCollide = true;
    existingAccount = makeExistingAccount({ emailVerified: true });
    const service = makeService();

    await expect(service.signup(makeDto())).rejects.toThrow(ConflictException);
    expect(accountRepo.findOne).toHaveBeenCalledWith({ where: { email: 'owner@example.com' } });
    expect(createUser).not.toHaveBeenCalled();
    expect(recordAccountCreated).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('unverified duplicate: same account id, a new verification job, no second Keycloak user, no new audit row', async () => {
    insertShouldCollide = true;
    existingAccount = makeExistingAccount();
    const service = makeService();

    const result = await service.signup(makeDto());
    expect(result).toEqual({ accountId: 'existing-account-id' });
    expect(createUser).not.toHaveBeenCalled();
    expect(recordAccountCreated).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd.mock.calls[0][1].accountId).toBe('existing-account-id');
  });

  it('unverified duplicate: carries the LATEST plan/cycle choice onto the account (FR-017)', async () => {
    insertShouldCollide = true;
    existingAccount = makeExistingAccount({ selectedBillingCycle: BillingCycle.ANNUAL });
    const service = makeService();

    await service.signup(makeDto({ billingCycle: BillingCycle.MONTHLY }));
    expect(accountRepo.update).toHaveBeenCalledWith('existing-account-id', {
      selectedPlanId: PLAN_ID,
      selectedBillingCycle: BillingCycle.MONTHLY,
    });
  });

  it('unverified duplicate with a now-unpublished plan: 422 prompting re-selection BEFORE the insert attempt', async () => {
    insertShouldCollide = true;
    existingAccount = makeExistingAccount();
    const service = makeService();

    await expect(
      service.signup(makeDto({ planId: '33333333-3333-4333-8333-333333333333' })),
    ).rejects.toThrow(UnprocessableEntityException);
    // Plan re-validation ran first — the duplicate path was never even entered.
    expect(planRepo.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      accountRepo.save.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(accountRepo.save).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('Keycloak failure: compensates the account row and answers a controlled 503 (no audit, no email job)', async () => {
    createUser.mockRejectedValue(new KeycloakUnavailableError('down'));
    const service = makeService();

    await expect(service.signup(makeDto())).rejects.toThrow(ServiceUnavailableException);
    expect(accountRepo.delete).toHaveBeenCalledWith({ id: 'generated-id-1' });
    expect(recordAccountCreated).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('Keycloak 409 conflict: same compensation path (503, no orphan row)', async () => {
    createUser.mockRejectedValue(new KeycloakUserConflictError('owner@example.com'));
    const service = makeService();

    await expect(service.signup(makeDto())).rejects.toThrow(ServiceUnavailableException);
    expect(accountRepo.delete).toHaveBeenCalledWith({ id: 'generated-id-1' });
  });

  it('audit failure: compensates BOTH the Keycloak user and the account row, answers 503, enqueues nothing', async () => {
    recordAccountCreated.mockRejectedValue(new Error('audit insert failed'));
    const service = makeService();

    await expect(service.signup(makeDto())).rejects.toThrow(ServiceUnavailableException);
    expect(createUser).toHaveBeenCalled();
    // The Keycloak user created in step 3 is deleted with the exact id it was created with.
    expect(deleteUser).toHaveBeenCalledWith(createUser.mock.calls[0][0].id);
    expect(accountRepo.delete).toHaveBeenCalledWith({ id: 'generated-id-1' });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('email enqueue failure: signup still succeeds (events.md: the job "does not block signup response")', async () => {
    queueAdd.mockRejectedValue(new Error('redis down'));
    const service = makeService();

    const result = await service.signup(makeDto());
    expect(result).toEqual({ accountId: 'generated-id-1' });
    expect(recordAccountCreated).toHaveBeenCalledTimes(1);
    expect(accountRepo.delete).not.toHaveBeenCalled();
  });

  it('token-issuance failure: signup still succeeds, no email job (no consumable link exists)', async () => {
    const service = makeService();
    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: any) => {
      if (target === Plan) {
        return planRepo as any;
      }
      if (target === Account) {
        return accountRepo as any;
      }
      if (target === EmailVerificationToken) {
        return { insert: jest.fn().mockRejectedValue(new Error('token insert failed')) } as any;
      }
      throw new Error(`Unexpected repository requested for ${String(target)}`);
    });

    const result = await service.signup(makeDto());
    expect(result).toEqual({ accountId: 'generated-id-1' });
    expect(recordAccountCreated).toHaveBeenCalledTimes(1);
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

describe('AccountsService.verifyEmail (T033, unit)', () => {
  const RAW_TOKEN = 'unit-test-raw-token-value';
  const TOKEN_HASH = hashVerificationToken(RAW_TOKEN);

  let accountRepo: { findOne: jest.Mock; update: jest.Mock };
  let tokenRepo: { findOne: jest.Mock };
  let planRepo: { findOne: jest.Mock };
  let markEmailVerified: jest.Mock;
  let recordAccountEmailVerified: jest.Mock;
  let tenantQueueAdd: jest.Mock;
  let query: jest.Mock;

  let tokenRow: EmailVerificationToken;
  let latestRow: EmailVerificationToken | null;
  let account: Account | null;
  let updateResult: { affected: number };

  function makeTokenRow(overrides: Partial<EmailVerificationToken> = {}): EmailVerificationToken {
    return {
      id: 'token-row-id',
      accountId: 'existing-account-id',
      tokenHash: TOKEN_HASH,
      tokenVersion: 'eeeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      issuanceSequence: '5',
      issuedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 3_600_000),
      consumedAt: null,
      ...overrides,
    } as EmailVerificationToken;
  }

  function makeAccount(overrides: Partial<Account> = {}): Account {
    return {
      id: 'existing-account-id',
      keycloakUserId: 'existing-kc-user-id',
      email: 'owner@example.com',
      emailVerified: false,
      mfaEnrolled: false,
      selectedPlanId: PLAN_ID,
      selectedBillingCycle: BillingCycle.MONTHLY,
      preferredLocale: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as Account;
  }

  beforeEach(() => {
    tokenRow = makeTokenRow();
    latestRow = tokenRow;
    account = makeAccount();
    updateResult = { affected: 1 };
    markEmailVerified = jest.fn().mockResolvedValue(undefined);
    recordAccountEmailVerified = jest.fn().mockResolvedValue(undefined);
    tenantQueueAdd = jest.fn().mockResolvedValue(undefined);
    query = jest.fn().mockResolvedValue([{ account_id: 'existing-account-id' }]);

    planRepo = { findOne: jest.fn() };
    accountRepo = {
      findOne: jest.fn().mockImplementation(async () => account),
      update: jest.fn().mockImplementation(async () => updateResult),
    };
    tokenRepo = {
      // First findOne: by tokenHash → the row. Second findOne: by accountId → latest row.
      findOne: jest
        .fn()
        .mockImplementation(async (criteria: { where: Record<string, unknown> }) => {
          if ('tokenHash' in criteria.where) {
            return tokenRow;
          }
          return latestRow;
        }),
    };

    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: any) => {
      if (target === Plan) {
        return planRepo as any;
      }
      if (target === Account) {
        return accountRepo as any;
      }
      if (target === EmailVerificationToken) {
        return tokenRepo as any;
      }
      throw new Error(`Unexpected repository requested for ${String(target)}`);
    });
    jest.spyOn(controlDataSource, 'query').mockImplementation(query as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeService(): AccountsService {
    const audit = { recordAccountEmailVerified } as unknown as AuditService;
    const emailQueue = { add: jest.fn() } as unknown as Queue;
    const tenantQueue = { add: tenantQueueAdd } as unknown as Queue;
    const provisioner = { createUser: jest.fn(), deleteUser: jest.fn(), markEmailVerified };
    return new AccountsService(audit, emailQueue, tenantQueue, provisioner as never);
  }

  function expectGone(reason: string): (service: AccountsService) => Promise<void> {
    return async (service: AccountsService) => {
      await expect(service.verifyEmail(RAW_TOKEN)).rejects.toThrow(HttpException);
      try {
        await service.verifyEmail(RAW_TOKEN);
      } catch (error) {
        const httpError = error as HttpException;
        expect(httpError.getStatus()).toBe(410);
        expect((httpError.getResponse() as { reason: string }).reason).toBe(reason);
      }
    };
  }

  it('happy path: mirror → atomic consume → one-way flag → audit → provision job, in that order', async () => {
    const service = makeService();
    const result = await service.verifyEmail(RAW_TOKEN);

    expect(result).toEqual({ accountId: 'existing-account-id' });
    expect(markEmailVerified).toHaveBeenCalledWith('existing-kc-user-id');
    expect(query).toHaveBeenCalledTimes(1); // the atomic decide+consume UPDATE
    expect(accountRepo.update).toHaveBeenCalledWith(
      { id: 'existing-account-id', emailVerified: false },
      { emailVerified: true },
    );
    expect(recordAccountEmailVerified).toHaveBeenCalledWith({ accountId: 'existing-account-id' });
    expect(tenantQueueAdd).toHaveBeenCalledWith(
      'provision',
      { accountId: 'existing-account-id' },
      { jobId: 'existing-account-id' }, // events.md: bare account_id job id
    );

    const order = [
      markEmailVerified.mock.invocationCallOrder[0],
      query.mock.invocationCallOrder[0],
      accountRepo.update.mock.invocationCallOrder[0],
      recordAccountEmailVerified.mock.invocationCallOrder[0],
      tenantQueueAdd.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('unknown token hash → 410 invalid, zero side effects', async () => {
    tokenRow = null as unknown as EmailVerificationToken;
    const service = makeService();
    await expectGone('invalid')(service);
    expect(markEmailVerified).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(recordAccountEmailVerified).not.toHaveBeenCalled();
  });

  it('already-consumed token → 410 used (Edge Case: link used twice)', async () => {
    tokenRow = makeTokenRow({ consumedAt: new Date() });
    await expectGone('used')(makeService());
  });

  it('expired token → 410 expired', async () => {
    tokenRow = makeTokenRow({ expiresAt: new Date(Date.now() - 1_000) });
    await expectGone('expired')(makeService());
  });

  it('newer link issued → 410 superseded (FR-021 latest-wins)', async () => {
    latestRow = makeTokenRow({ id: 'newer-token-row-id', issuanceSequence: '6' });
    await expectGone('superseded')(makeService());
  });

  it('live token for an already-verified account → 410 used (one-way state)', async () => {
    account = makeAccount({ emailVerified: true });
    await expectGone('used')(makeService());
  });

  it('Keycloak mirror failure → 503, token NOT consumed (same link stays retryable)', async () => {
    markEmailVerified.mockRejectedValue(new KeycloakUnavailableError('kc down'));
    await expect(makeService().verifyEmail(RAW_TOKEN)).rejects.toThrow(ServiceUnavailableException);
    expect(query).not.toHaveBeenCalled();
    expect(accountRepo.update).not.toHaveBeenCalled();
    expect(recordAccountEmailVerified).not.toHaveBeenCalled();
    expect(tenantQueueAdd).not.toHaveBeenCalled();
  });

  it('atomic consume loses the race → 410 used, no flag/audit/job work', async () => {
    query.mockResolvedValue([]);
    await expectGone('used')(makeService());
    expect(accountRepo.update).not.toHaveBeenCalled();
    expect(recordAccountEmailVerified).not.toHaveBeenCalled();
  });

  it('audit failure → compensates flag flip AND token consumption, answers 503', async () => {
    recordAccountEmailVerified.mockRejectedValue(new Error('audit insert failed'));
    await expect(makeService().verifyEmail(RAW_TOKEN)).rejects.toThrow(ServiceUnavailableException);

    // Flag flipped then un-flipped; token consumed then un-consumed.
    expect(accountRepo.update).toHaveBeenNthCalledWith(
      1,
      { id: 'existing-account-id', emailVerified: false },
      { emailVerified: true },
    );
    expect(accountRepo.update).toHaveBeenNthCalledWith(
      2,
      { id: 'existing-account-id', emailVerified: true },
      { emailVerified: false },
    );
    expect(query).toHaveBeenCalledTimes(2); // consume + compensation un-consume
    expect(tenantQueueAdd).not.toHaveBeenCalled();
  });

  it('provision enqueue failure → verification still succeeds (recoverable via T045 retry)', async () => {
    tenantQueueAdd.mockRejectedValue(new Error('redis down'));
    const service = makeService();
    const result = await service.verifyEmail(RAW_TOKEN);
    expect(result).toEqual({ accountId: 'existing-account-id' });
    expect(recordAccountEmailVerified).toHaveBeenCalledTimes(1);
  });

  it('concurrent winner already flipped the flag → 200 no-op, NO duplicate audit or job', async () => {
    updateResult = { affected: 0 };
    const service = makeService();
    const result = await service.verifyEmail(RAW_TOKEN);
    expect(result).toEqual({ accountId: 'existing-account-id' });
    expect(recordAccountEmailVerified).not.toHaveBeenCalled();
    expect(tenantQueueAdd).not.toHaveBeenCalled();
  });
});
