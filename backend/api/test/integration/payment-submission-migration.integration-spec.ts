import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import {
  PaymentSubmission,
  PaymentSubmissionStatus,
} from '../../src/modules/billing-customer/entities/payment-submission.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant } from '../../src/modules/tenants/entities/tenant.entity';

/**
 * T012 acceptance test. Requires a reachable Postgres configured via CONTROL_DB_* env vars, same
 * convention as T011's subscription-migration.integration-spec.ts.
 */
describe('PaymentSubmission migration + entity (T012)', () => {
  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();
  });

  afterEach(async () => {
    await controlDataSource.query('DELETE FROM "payment_submission"');
    await controlDataSource.query('DELETE FROM "subscription"');
    await controlDataSource.query('DELETE FROM "tenant"');
    await controlDataSource.query('DELETE FROM "plan"');
    await controlDataSource.query('DELETE FROM "account"');
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  async function createAccount(email: string) {
    const repo = controlDataSource.getRepository(Account);
    return repo.save(
      repo.create({
        keycloakUserId: '11111111-1111-1111-1111-111111111111',
        email,
        emailVerified: true,
        mfaEnrolled: false,
      }),
    );
  }

  async function createTenant(accountId: string) {
    const repo = controlDataSource.getRepository(Tenant);
    return repo.save(repo.create({ accountId }));
  }

  async function createPlan(name: string) {
    const repo = controlDataSource.getRepository(Plan);
    return repo.save(
      repo.create({
        name,
        published: true,
        monthlyPrice: '10.00',
        annualPrice: '100.00',
        currency: 'USD',
      }),
    );
  }

  async function createSubscription(tenantId: string, planId: string) {
    const repo = controlDataSource.getRepository(Subscription);
    return repo.save(
      repo.create({
        tenantId,
        planId,
        billingCycle: SubscriptionBillingCycle.MONTHLY,
        currentPeriodStart: '2026-01-01',
        currentPeriodEnd: '2026-01-31',
      }),
    );
  }

  async function setupTenantWithSubscription(label: string) {
    const account = await createAccount(`owner-${label}@example.com`);
    const tenant = await createTenant(account.id);
    const plan = await createPlan(`Plan ${label}`);
    const subscription = await createSubscription(tenant.id, plan.id);
    return { account, tenant, plan, subscription };
  }

  function makeSubmission(overrides: Partial<PaymentSubmission> = {}) {
    const repo = controlDataSource.getRepository(PaymentSubmission);
    return repo.create({
      billingPeriodStart: '2026-01-01',
      billingPeriodEnd: '2026-01-31',
      amount: '10.00',
      currency: 'USD',
      bankReference: `REF-${Math.random().toString(36).slice(2, 10)}`,
      proofObjectKey: 'tenant-bucket/proof.pdf',
      ...overrides,
    });
  }

  it('blocks a second unresolved submission for the same tenant+period at the DB level (FR-033)', async () => {
    const { tenant, subscription } = await setupTenantWithSubscription('a');
    const repo = controlDataSource.getRepository(PaymentSubmission);

    await repo.save(makeSubmission({ tenantId: tenant.id, subscriptionId: subscription.id }));

    await expect(
      repo.save(makeSubmission({ tenantId: tenant.id, subscriptionId: subscription.id })),
    ).rejects.toThrow();
  });

  it('allows a new submission for the same tenant+period once the prior one is resolved', async () => {
    const { tenant, subscription } = await setupTenantWithSubscription('b');
    const repo = controlDataSource.getRepository(PaymentSubmission);

    const first = await repo.save(
      makeSubmission({ tenantId: tenant.id, subscriptionId: subscription.id }),
    );
    first.status = PaymentSubmissionStatus.REJECTED;
    await repo.save(first);

    await expect(
      repo.save(makeSubmission({ tenantId: tenant.id, subscriptionId: subscription.id })),
    ).resolves.toBeDefined();
  });

  it('enforces bank_reference uniqueness', async () => {
    const { tenant, subscription } = await setupTenantWithSubscription('c');
    const repo = controlDataSource.getRepository(PaymentSubmission);

    await repo.save(
      makeSubmission({
        tenantId: tenant.id,
        subscriptionId: subscription.id,
        bankReference: 'DUPLICATE-REF',
      }),
    );

    await expect(
      repo.save(
        makeSubmission({
          tenantId: tenant.id,
          subscriptionId: subscription.id,
          billingPeriodStart: '2026-02-01',
          billingPeriodEnd: '2026-02-28',
          bankReference: 'DUPLICATE-REF',
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects a submission referencing a nonexistent tenant or subscription (FK constraints)', async () => {
    const { tenant, subscription } = await setupTenantWithSubscription('d');
    const repo = controlDataSource.getRepository(PaymentSubmission);

    await expect(
      repo.save(
        makeSubmission({
          tenantId: '99999999-9999-9999-9999-999999999999',
          subscriptionId: subscription.id,
        }),
      ),
    ).rejects.toThrow();

    await expect(
      repo.save(
        makeSubmission({
          tenantId: tenant.id,
          subscriptionId: '99999999-9999-9999-9999-999999999999',
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects a tenant_id/subscription_id pairing that crosses tenants (tenant isolation)', async () => {
    const tenantA = await setupTenantWithSubscription('e1');
    const tenantB = await setupTenantWithSubscription('e2');
    const repo = controlDataSource.getRepository(PaymentSubmission);

    await expect(
      repo.save(
        makeSubmission({ tenantId: tenantA.tenant.id, subscriptionId: tenantB.subscription.id }),
      ),
    ).rejects.toThrow();

    await expect(
      repo.save(
        makeSubmission({ tenantId: tenantB.tenant.id, subscriptionId: tenantA.subscription.id }),
      ),
    ).rejects.toThrow();
  });

  it('allows appending new status_history entries', async () => {
    const { tenant, subscription } = await setupTenantWithSubscription('f');
    const repo = controlDataSource.getRepository(PaymentSubmission);

    const saved = await repo.save(
      makeSubmission({
        tenantId: tenant.id,
        subscriptionId: subscription.id,
        statusHistory: [
          {
            status: PaymentSubmissionStatus.PENDING_REVIEW,
            changedAt: '2026-01-01T00:00:00.000Z',
            changedBy: null,
            notes: null,
          },
        ],
      }),
    );

    saved.statusHistory = [
      ...saved.statusHistory,
      {
        status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
        changedAt: '2026-01-02T00:00:00.000Z',
        changedBy: tenant.accountId,
        notes: 'need clearer proof',
      },
    ];
    const updated = await repo.save(saved);

    expect(updated.statusHistory).toHaveLength(2);
  });

  it('rejects an UPDATE that removes an existing status_history entry', async () => {
    const { tenant, subscription } = await setupTenantWithSubscription('g');
    const repo = controlDataSource.getRepository(PaymentSubmission);

    const saved = await repo.save(
      makeSubmission({
        tenantId: tenant.id,
        subscriptionId: subscription.id,
        statusHistory: [
          {
            status: PaymentSubmissionStatus.PENDING_REVIEW,
            changedAt: '2026-01-01T00:00:00.000Z',
            changedBy: null,
            notes: null,
          },
          {
            status: PaymentSubmissionStatus.MORE_INFO_REQUESTED,
            changedAt: '2026-01-02T00:00:00.000Z',
            changedBy: null,
            notes: null,
          },
        ],
      }),
    );

    saved.statusHistory = [saved.statusHistory[1]];

    await expect(repo.save(saved)).rejects.toThrow();
  });

  it('rejects an UPDATE that rewrites an existing status_history entry', async () => {
    const { tenant, subscription } = await setupTenantWithSubscription('h');
    const repo = controlDataSource.getRepository(PaymentSubmission);

    const saved = await repo.save(
      makeSubmission({
        tenantId: tenant.id,
        subscriptionId: subscription.id,
        statusHistory: [
          {
            status: PaymentSubmissionStatus.PENDING_REVIEW,
            changedAt: '2026-01-01T00:00:00.000Z',
            changedBy: null,
            notes: null,
          },
        ],
      }),
    );

    saved.statusHistory = [{ ...saved.statusHistory[0], notes: 'tampered' }];

    await expect(repo.save(saved)).rejects.toThrow();
  });

  it("matches data-model.md's PaymentSubmission table: persists every documented field verbatim", async () => {
    const { tenant, subscription, account } = await setupTenantWithSubscription('i');
    const repo = controlDataSource.getRepository(PaymentSubmission);

    const saved = await repo.save(
      makeSubmission({
        tenantId: tenant.id,
        subscriptionId: subscription.id,
        status: PaymentSubmissionStatus.APPROVED,
        reviewedBy: account.id,
        reviewedAt: new Date('2026-01-05T00:00:00.000Z'),
        decisionNotes: 'looks good',
      }),
    );

    const reloaded = await repo.findOneByOrFail({ id: saved.id });
    expect(reloaded.tenantId).toBe(tenant.id);
    expect(reloaded.subscriptionId).toBe(subscription.id);
    expect(reloaded.billingPeriodStart).toBe('2026-01-01');
    expect(reloaded.billingPeriodEnd).toBe('2026-01-31');
    expect(reloaded.amount).toBe('10.00');
    expect(reloaded.currency).toBe('USD');
    expect(reloaded.proofObjectKey).toBe('tenant-bucket/proof.pdf');
    expect(reloaded.status).toBe(PaymentSubmissionStatus.APPROVED);
    expect(reloaded.submittedAt).toBeInstanceOf(Date);
    expect(reloaded.reviewedBy).toBe(account.id);
    expect(reloaded.reviewedAt).toBeInstanceOf(Date);
    expect(reloaded.decisionNotes).toBe('looks good');
    expect(reloaded.statusHistory).toEqual([]);
  });

  it('defaults status to PendingReview, status_history to [], and leaves review fields null', async () => {
    const { tenant, subscription } = await setupTenantWithSubscription('j');
    const repo = controlDataSource.getRepository(PaymentSubmission);

    const saved = await repo.save(
      makeSubmission({ tenantId: tenant.id, subscriptionId: subscription.id }),
    );

    expect(saved.status).toBe(PaymentSubmissionStatus.PENDING_REVIEW);
    expect(saved.statusHistory).toEqual([]);
    expect(saved.reviewedBy).toBeNull();
    expect(saved.reviewedAt).toBeNull();
    expect(saved.decisionNotes).toBeNull();
  });

  it('rejects INSERT of a non-array status_history (object or scalar) at the DB level', async () => {
    const { tenant, subscription } = await setupTenantWithSubscription('k');

    const insertWith = (statusHistoryJson: string) =>
      controlDataSource.query(
        `INSERT INTO "payment_submission"
           ("tenant_id", "subscription_id", "billing_period_start", "billing_period_end",
            "amount", "currency", "bank_reference", "proof_object_key", "status_history")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          tenant.id,
          subscription.id,
          '2026-01-01',
          '2026-01-31',
          '10.00',
          'USD',
          `REF-${Math.random().toString(36).slice(2, 10)}`,
          'tenant-bucket/proof.pdf',
          statusHistoryJson,
        ],
      );

    await expect(insertWith('{"status":"PendingReview"}')).rejects.toThrow();
    await expect(insertWith('"PendingReview"')).rejects.toThrow();
  });

  it('the status enum matches PendingReview|Approved|Rejected|MoreInfoRequested exactly', async () => {
    const rows = await controlDataSource.query(`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'payment_submission_status_enum'
      ORDER BY e.enumsortorder
    `);
    const labels = rows.map((r: { enumlabel: string }) => r.enumlabel);
    expect(labels).toEqual(['PendingReview', 'Approved', 'Rejected', 'MoreInfoRequested']);
  });
});
