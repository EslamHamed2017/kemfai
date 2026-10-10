import { randomUUID } from 'crypto';
import { QueryFailedError } from 'typeorm';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { SubscriptionBillingCycle } from '../../src/modules/billing-customer/entities/subscription.entity';
import { PaymentSubmissionStatus } from '../../src/modules/billing-customer/entities/payment-submission.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant } from '../../src/modules/tenants/entities/tenant.entity';

interface FixtureIds {
  accountId: string;
  tenantId: string;
  planId: string;
  subscriptionId: string;
}

interface PostgresConstraintError {
  code?: string;
  constraint?: string;
}

const PERIOD_START = '2026-10-01';
const PERIOD_END = '2026-10-31';
const UNIQUE_VIOLATION = '23505';
const UNRESOLVED_PERIOD_CONSTRAINT = 'uq_payment_submission_unresolved_period';

/**
 * T058: exercises FR-033 directly against PostgreSQL, bypassing application services. Two
 * dedicated QueryRunners guarantee that both inserts are dispatched on different database
 * sessions before either result is awaited.
 */
describe('PaymentSubmission unresolved-period concurrency (T058)', () => {
  let fixture: FixtureIds | undefined;

  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();
  });

  afterEach(async () => {
    if (!fixture) {
      return;
    }

    await controlDataSource.query('DELETE FROM "payment_submission" WHERE "tenant_id" = $1', [
      fixture.tenantId,
    ]);
    await controlDataSource.query('DELETE FROM "subscription" WHERE "id" = $1', [
      fixture.subscriptionId,
    ]);
    await controlDataSource.query('DELETE FROM "tenant" WHERE "id" = $1', [fixture.tenantId]);
    await controlDataSource.query('DELETE FROM "plan" WHERE "id" = $1', [fixture.planId]);
    await controlDataSource.query('DELETE FROM "account" WHERE "id" = $1', [fixture.accountId]);
    fixture = undefined;
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  async function createFixture(label: string): Promise<FixtureIds> {
    const id = randomUUID();
    const accountRepository = controlDataSource.getRepository(Account);
    const account = await accountRepository.save(
      accountRepository.create({
        keycloakUserId: randomUUID(),
        email: `t058-${label}-${id}@example.test`,
        emailVerified: true,
        mfaEnrolled: false,
      }),
    );

    const tenantRepository = controlDataSource.getRepository(Tenant);
    const tenant = await tenantRepository.save(tenantRepository.create({ accountId: account.id }));

    const planRepository = controlDataSource.getRepository(Plan);
    const plan = await planRepository.save(
      planRepository.create({
        name: `T058 private fixture ${label} ${id}`,
        published: false,
        monthlyPrice: '10.00',
        annualPrice: '100.00',
        currency: 'USD',
      }),
    );

    const [{ id: subscriptionId }] = await controlDataSource.query(
      `INSERT INTO "subscription"
         ("tenant_id", "plan_id", "billing_cycle", "current_period_start", "current_period_end")
       VALUES ($1, $2, $3, $4, $5)
       RETURNING "id"`,
      [tenant.id, plan.id, SubscriptionBillingCycle.MONTHLY, PERIOD_START, PERIOD_END],
    );

    fixture = {
      accountId: account.id,
      tenantId: tenant.id,
      planId: plan.id,
      subscriptionId,
    };
    return fixture;
  }

  function insertUnresolvedSubmission(
    queryRunner: ReturnType<typeof controlDataSource.createQueryRunner>,
    fixtureIds: FixtureIds,
    status: PaymentSubmissionStatus,
  ): Promise<unknown> {
    return queryRunner.query(
      `INSERT INTO "payment_submission"
         ("tenant_id", "subscription_id", "billing_period_start", "billing_period_end",
          "amount", "currency", "bank_reference", "proof_object_key", "status")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING "id"`,
      [
        fixtureIds.tenantId,
        fixtureIds.subscriptionId,
        PERIOD_START,
        PERIOD_END,
        '10.00',
        'USD',
        `T058-${randomUUID()}`,
        `t058-private/${randomUUID()}/proof.pdf`,
        status,
      ],
    );
  }

  function postgresConstraintError(reason: unknown): PostgresConstraintError {
    if (reason instanceof QueryFailedError) {
      return reason.driverError as PostgresConstraintError;
    }
    return reason as PostgresConstraintError;
  }

  it.each([
    [PaymentSubmissionStatus.PENDING_REVIEW, PaymentSubmissionStatus.PENDING_REVIEW],
    [PaymentSubmissionStatus.MORE_INFO_REQUESTED, PaymentSubmissionStatus.MORE_INFO_REQUESTED],
    [PaymentSubmissionStatus.PENDING_REVIEW, PaymentSubmissionStatus.MORE_INFO_REQUESTED],
  ])(
    'rejects one of two concurrent %s/%s inserts for the same tenant and period at the constraint level',
    async (firstStatus, secondStatus) => {
      const fixtureIds = await createFixture(`${firstStatus}-${secondStatus}`);
      const firstRunner = controlDataSource.createQueryRunner();
      const secondRunner = controlDataSource.createQueryRunner();

      await Promise.all([firstRunner.connect(), secondRunner.connect()]);

      try {
        const [[firstPid], [secondPid]] = await Promise.all([
          firstRunner.query('SELECT pg_backend_pid() AS pid'),
          secondRunner.query('SELECT pg_backend_pid() AS pid'),
        ]);
        expect(firstPid.pid).not.toBe(secondPid.pid);

        const results = await Promise.allSettled([
          insertUnresolvedSubmission(firstRunner, fixtureIds, firstStatus),
          insertUnresolvedSubmission(secondRunner, fixtureIds, secondStatus),
        ]);

        const fulfilled = results.filter(
          (result): result is PromiseFulfilledResult<unknown> => result.status === 'fulfilled',
        );
        const rejected = results.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const databaseError = postgresConstraintError(rejected[0].reason);
        expect(databaseError.code).toBe(UNIQUE_VIOLATION);
        expect(databaseError.constraint).toBe(UNRESOLVED_PERIOD_CONSTRAINT);

        const [{ unresolved_count: unresolvedCount }] = await controlDataSource.query(
          `SELECT count(*)::int AS unresolved_count
           FROM "payment_submission"
           WHERE "tenant_id" = $1
             AND "billing_period_start" = $2
             AND "billing_period_end" = $3
             AND "status" IN ('PendingReview', 'MoreInfoRequested')`,
          [fixtureIds.tenantId, PERIOD_START, PERIOD_END],
        );
        expect(unresolvedCount).toBe(1);
      } finally {
        await Promise.all([firstRunner.release(), secondRunner.release()]);
      }
    },
  );
});
