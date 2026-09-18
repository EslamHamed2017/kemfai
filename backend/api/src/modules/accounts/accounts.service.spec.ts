import {
  ConflictException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import controlDataSource from '../../database/data-source';
import { AuditService } from '../audit/audit.service';
import { Plan } from '../entitlements/entities/plan.entity';
import { Account, BillingCycle } from './entities/account.entity';
import { AccountsService } from './accounts.service';
import { SignupRequestDto } from './dto/signup.request.dto';
import {
  KeycloakUserConflictError,
  KeycloakUnavailableError,
} from '../../integrations/keycloak/keycloak-user-provisioner';

/**
 * Unit coverage of the T032 signup saga's ordering, revalidation, and compensation rules
 * (review findings 2026-09-19 00:37 + 00:57) with stubbed repositories/queue/provisioner.
 * DB-level proof (unique email constraint as the idempotency anchor, audit rows, BullMQ
 * job ids) lives in test/integration/accounts-signup.integration-spec.ts.
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
  let recordAccountCreated: jest.Mock;
  let queueAdd: jest.Mock;
  let insertShouldCollide: boolean;
  let existingAccount: Account | null;

  beforeEach(() => {
    insertShouldCollide = false;
    existingAccount = null;
    createUser = jest.fn().mockResolvedValue(undefined);
    deleteUser = jest.fn().mockResolvedValue(undefined);
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

    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: any) => {
      if (target === Plan) {
        return planRepo as any;
      }
      if (target === Account) {
        return accountRepo as any;
      }
      throw new Error(`Unexpected repository requested for ${String(target)}`);
    });

    const audit = { recordAccountCreated } as unknown as AuditService;
    const queue = { add: queueAdd } as unknown as Queue;
    const provisioner = { createUser, deleteUser };
    return new AccountsService(audit, queue, provisioner as never);
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
      { accountId: string; tokenVersion: string },
      { jobId: string },
    ];
    expect(jobName).toBe('send');
    expect(payload.accountId).toBe('generated-id-1');
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
});
