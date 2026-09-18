import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant } from '../../src/modules/tenants/entities/tenant.entity';

/**
 * T011 acceptance test. Requires a reachable Postgres configured via CONTROL_DB_* env vars, same
 * convention as T007/T008/T009's migration integration specs.
 */
describe('Subscription migration + entity (T011)', () => {
  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();
  });

  afterEach(async () => {
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

  it('enforces a unique constraint on tenant_id (one Subscription row per tenant)', async () => {
    const account = await createAccount('owner-a@example.com');
    const tenant = await createTenant(account.id);
    const plan = await createPlan('Plan A');
    const repo = controlDataSource.getRepository(Subscription);

    await repo.save(
      repo.create({
        tenantId: tenant.id,
        planId: plan.id,
        billingCycle: SubscriptionBillingCycle.MONTHLY,
        currentPeriodStart: '2026-01-01',
        currentPeriodEnd: '2026-01-31',
      }),
    );

    await expect(
      repo.save(
        repo.create({
          tenantId: tenant.id,
          planId: plan.id,
          billingCycle: SubscriptionBillingCycle.MONTHLY,
          currentPeriodStart: '2026-02-01',
          currentPeriodEnd: '2026-02-28',
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects a subscription referencing a nonexistent tenant or plan (FK constraints)', async () => {
    const account = await createAccount('owner-b@example.com');
    const tenant = await createTenant(account.id);
    const plan = await createPlan('Plan B');
    const repo = controlDataSource.getRepository(Subscription);

    await expect(
      repo.save(
        repo.create({
          tenantId: '99999999-9999-9999-9999-999999999999',
          planId: plan.id,
          billingCycle: SubscriptionBillingCycle.MONTHLY,
          currentPeriodStart: '2026-01-01',
          currentPeriodEnd: '2026-01-31',
        }),
      ),
    ).rejects.toThrow();

    await expect(
      repo.save(
        repo.create({
          tenantId: tenant.id,
          planId: '99999999-9999-9999-9999-999999999999',
          billingCycle: SubscriptionBillingCycle.MONTHLY,
          currentPeriodStart: '2026-01-01',
          currentPeriodEnd: '2026-01-31',
        }),
      ),
    ).rejects.toThrow();
  });

  it("matches data-model.md's Subscription table: persists every documented field verbatim", async () => {
    const account = await createAccount('owner-c@example.com');
    const activator = await createAccount('billing-admin@example.com');
    const tenant = await createTenant(account.id);
    const plan = await createPlan('Plan C');
    const repo = controlDataSource.getRepository(Subscription);

    const saved = await repo.save(
      repo.create({
        tenantId: tenant.id,
        planId: plan.id,
        billingCycle: SubscriptionBillingCycle.ANNUAL,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: '2026-01-01',
        currentPeriodEnd: '2026-12-31',
        activatedAt: new Date('2026-01-02T00:00:00.000Z'),
        activatedBy: activator.id,
      }),
    );

    const reloaded = await repo.findOneByOrFail({ id: saved.id });
    expect(reloaded.tenantId).toBe(tenant.id);
    expect(reloaded.planId).toBe(plan.id);
    expect(reloaded.billingCycle).toBe(SubscriptionBillingCycle.ANNUAL);
    expect(reloaded.status).toBe(SubscriptionStatus.ACTIVE);
    expect(reloaded.currentPeriodStart).toBe('2026-01-01');
    expect(reloaded.currentPeriodEnd).toBe('2026-12-31');
    expect(reloaded.activatedAt).toBeInstanceOf(Date);
    expect(reloaded.activatedBy).toBe(activator.id);
    expect(reloaded.createdAt).toBeInstanceOf(Date);
    expect(reloaded.updatedAt).toBeInstanceOf(Date);
  });

  it('defaults status to PendingActivation and leaves activated_at/activated_by null', async () => {
    const account = await createAccount('owner-d@example.com');
    const tenant = await createTenant(account.id);
    const plan = await createPlan('Plan D');
    const repo = controlDataSource.getRepository(Subscription);

    const saved = await repo.save(
      repo.create({
        tenantId: tenant.id,
        planId: plan.id,
        billingCycle: SubscriptionBillingCycle.MONTHLY,
        currentPeriodStart: '2026-01-01',
        currentPeriodEnd: '2026-01-31',
      }),
    );

    expect(saved.status).toBe(SubscriptionStatus.PENDING_ACTIVATION);
    expect(saved.activatedAt).toBeNull();
    expect(saved.activatedBy).toBeNull();
  });

  it('the status enum matches PendingActivation|Active|Suspended|Cancelled exactly', async () => {
    const rows = await controlDataSource.query(`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'subscription_status_enum'
      ORDER BY e.enumsortorder
    `);
    const labels = rows.map((r: { enumlabel: string }) => r.enumlabel);
    expect(labels).toEqual(['PendingActivation', 'Active', 'Suspended', 'Cancelled']);
  });

  it('the billing_cycle enum matches monthly|annual exactly', async () => {
    const rows = await controlDataSource.query(`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'subscription_billing_cycle_enum'
      ORDER BY e.enumsortorder
    `);
    const labels = rows.map((r: { enumlabel: string }) => r.enumlabel);
    expect(labels).toEqual(['monthly', 'annual']);
  });
});
