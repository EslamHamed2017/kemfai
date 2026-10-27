import { randomUUID } from 'crypto';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { Tenant } from '../../src/modules/tenants/entities/tenant.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import {
  PaymentSubmission,
  PaymentSubmissionStatus,
} from '../../src/modules/billing-customer/entities/payment-submission.entity';
import { assertAuditSourceLinked } from '../support/audit-source-linkage';
import { loadAndVerifyT093Captures } from '../support/t093-capture-artifact';

describe('T093 cross-suite audit source linkage', () => {
  beforeAll(async () => {
    if (!controlDataSource.isInitialized) await controlDataSource.initialize();
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) await controlDataSource.destroy();
  });

  it('rejects wrong-tenant, deleted, unknown, and invalid payment-history links', async () => {
    const accounts = controlDataSource.getRepository(Account);
    const tenants = controlDataSource.getRepository(Tenant);
    const plans = controlDataSource.getRepository(Plan);
    const subscriptions = controlDataSource.getRepository(Subscription);
    const payments = controlDataSource.getRepository(PaymentSubmission);
    const firstAccount = await accounts.save(
      accounts.create({
        keycloakUserId: randomUUID(),
        email: `t093-${randomUUID()}@example.invalid`,
        emailVerified: true,
      }),
    );
    const firstTenant = await tenants.save(tenants.create({ accountId: firstAccount.id }));
    const secondAccount = await accounts.save(
      accounts.create({
        keycloakUserId: randomUUID(),
        email: `t093-${randomUUID()}@example.invalid`,
        emailVerified: true,
      }),
    );
    const secondTenant = await tenants.save(tenants.create({ accountId: secondAccount.id }));

    const tenantLink = {
      action: 'tenant.provisioning.succeeded',
      subjectType: 'tenant',
      subjectId: firstTenant.id,
      tenantId: secondTenant.id,
      payload: {},
    };
    await expect(assertAuditSourceLinked(controlDataSource, tenantLink)).rejects.toThrow(
      /missing|wrong tenant/,
    );
    await tenants.delete(firstTenant.id);
    await expect(
      assertAuditSourceLinked(controlDataSource, { ...tenantLink, tenantId: firstTenant.id }),
    ).rejects.toThrow(/missing|wrong tenant/);
    await expect(
      assertAuditSourceLinked(controlDataSource, { ...tenantLink, subjectType: 'unknown' }),
    ).rejects.toThrow(/unrecognized/);

    const plan = await plans.save(
      plans.create({
        name: `T093 ${randomUUID()}`,
        published: true,
        monthlyPrice: '1.00',
        annualPrice: '10.00',
        currency: 'USD',
      }),
    );
    const subscription = await subscriptions.save(
      subscriptions.create({
        tenantId: secondTenant.id,
        planId: plan.id,
        billingCycle: SubscriptionBillingCycle.MONTHLY,
        currentPeriodStart: '2026-01-01',
        currentPeriodEnd: '2026-01-31',
      }),
    );
    const historyEntry = {
      status: PaymentSubmissionStatus.PENDING_REVIEW,
      changedAt: '2026-01-01T00:00:00.000Z',
      changedBy: null,
      notes: null,
    };
    const payment = await payments.save(
      payments.create({
        tenantId: secondTenant.id,
        subscriptionId: subscription.id,
        billingPeriodStart: '2026-01-01',
        billingPeriodEnd: '2026-01-31',
        amount: '1.00',
        currency: 'USD',
        bankReference: randomUUID(),
        proofObjectKey: 't093/proof.pdf',
        statusHistory: [historyEntry],
      }),
    );
    const paymentLink = {
      action: 'billing.payment_submission.decided',
      subjectType: 'payment_submission',
      subjectId: payment.id,
      tenantId: secondTenant.id,
      payload: {},
    };
    for (const status_history of [
      undefined,
      [],
      'malformed',
      { fabricated: true },
      [{ ...historyEntry, fabricated: true }],
    ]) {
      await expect(
        assertAuditSourceLinked(controlDataSource, {
          ...paymentLink,
          payload: { status_history },
        }),
      ).rejects.toThrow(/history/);
    }
    await expect(
      assertAuditSourceLinked(controlDataSource, {
        ...paymentLink,
        payload: {
          status_history: [
            {
              notes: historyEntry.notes,
              changedBy: historyEntry.changedBy,
              status: historyEntry.status,
              changedAt: historyEntry.changedAt,
            },
          ],
        },
      }),
    ).resolves.toBeUndefined();

    await payments.delete(payment.id);
    await subscriptions.delete(subscription.id);
    await plans.delete(plan.id);
    await tenants.delete(secondTenant.id);
    await accounts.delete([firstAccount.id, secondAccount.id]);
  });

  it('does not retain an audit write rolled back with its source transaction', async () => {
    const runner = controlDataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    const eventId = randomUUID();
    try {
      const accountRows = await runner.query(
        `INSERT INTO account(keycloak_user_id,email,email_verified,mfa_enrolled)
         VALUES($1,$2,true,false) RETURNING id`,
        [randomUUID(), `t093-rollback-${randomUUID()}@example.invalid`],
      );
      const tenantRows = await runner.query(
        `INSERT INTO tenant(account_id,status) VALUES($1,'Pending'::tenant_status_enum) RETURNING id`,
        [accountRows[0].id],
      );
      await runner.query(
        `INSERT INTO audit_event(id,actor_type,actor_id,tenant_id,action,subject_type,subject_id,payload)
         VALUES($1,'account',$2,$3,'tenant.provisioning.attempted','tenant',$3,'{}'::jsonb)`,
        [eventId, accountRows[0].id, tenantRows[0].id],
      );
      await runner.rollbackTransaction();
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
    const captures = await controlDataSource.query(
      'SELECT count(*)::int AS count FROM t093_audit_capture WHERE event_id=$1',
      [eventId],
    );
    expect(captures[0].count).toBe(0);
  });

  it('has one terminal capture for every successful persisted audit write', async () => {
    const capturePath = process.env.T093_CAPTURE_JSONL;
    expect(capturePath).toBeTruthy();
    expect(loadAndVerifyT093Captures(capturePath!).length).toBeGreaterThan(0);
  });
});
