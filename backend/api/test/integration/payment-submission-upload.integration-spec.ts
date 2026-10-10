import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import controlDataSource from '../../src/database/data-source';
import { AppModule } from '../../src/app.module';
import { Account, BillingCycle } from '../../src/modules/accounts/entities/account.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

const PAYMENT_SUBMISSIONS_PATH = '/billing/payment-submissions';
const MAX_PAYMENT_PROOF_BYTES = 10 * 1024 * 1024;
const ISSUER = 'http://127.0.0.1/realms/kemfai-customers-t059';
const AUDIENCE = 'kemfai-api-t059';

interface FixtureIds {
  accountId: string;
  tenantId: string;
  planId: string;
  subscriptionId: string;
}

/**
 * T059 test-first integration specification for Acceptance Scenario 5.4.
 *
 * Requests cross the real Nest HTTP adapter and production AppModule (including its global
 * authentication, tenant, role, feature-flag, trial-window, and idempotency layers). The only
 * stand-in is the existing in-process JWKS fixture, which still exercises BearerAuthGuard's real
 * RS256/JWKS network verification. T062 owns the controller/service implementation that makes
 * these expectations green; this file deliberately supplies no probe controller or mocked route.
 *
 * The feature specification explicitly leaves exact upload limits as an implementation detail.
 * This executable boundary selects 10 MiB and treats PDF/PNG/JPEG as supported proof formats;
 * neither choice changes a locked product/accounting/tax/legal decision.
 */
describe('Payment-submission upload rejection (T059)', () => {
  let app: INestApplication;
  let keycloak: FakeKeycloak;
  const fixture: Partial<FixtureIds> = {};
  let ownerToken: string;
  const originalAuthEnvironment = {
    issuer: process.env.KEYCLOAK_ISSUER,
    audience: process.env.KEYCLOAK_API_AUDIENCE,
    jwksUri: process.env.KEYCLOAK_JWKS_URI,
  };

  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    keycloak = await startFakeKeycloak({ issuer: ISSUER, audience: AUDIENCE });
    process.env.KEYCLOAK_ISSUER = ISSUER;
    process.env.KEYCLOAK_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const fixtureLabel = randomUUID();
    const ownerSubject = randomUUID();

    const planRepository = controlDataSource.getRepository(Plan);
    const plan = await planRepository.save(
      planRepository.create({
        name: `T059 private fixture ${fixtureLabel}`,
        published: false,
        monthlyPrice: '10.00',
        annualPrice: '100.00',
        currency: 'USD',
      }),
    );
    fixture.planId = plan.id;

    const accountRepository = controlDataSource.getRepository(Account);
    const account = await accountRepository.save(
      accountRepository.create({
        keycloakUserId: ownerSubject,
        email: `t059-owner-${fixtureLabel}@example.invalid`,
        emailVerified: true,
        mfaEnrolled: false,
        selectedPlanId: plan.id,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
    );
    fixture.accountId = account.id;

    const tenantRepository = controlDataSource.getRepository(Tenant);
    const tenant = await tenantRepository.save(
      tenantRepository.create({
        accountId: account.id,
        status: TenantStatus.READY,
        readyAt: new Date(),
        minioBucket: `kemfai-tenant-t059-${fixtureLabel}`,
      }),
    );
    fixture.tenantId = tenant.id;

    const subscriptionRepository = controlDataSource.getRepository(Subscription);
    const subscription = await subscriptionRepository.save(
      subscriptionRepository.create({
        tenantId: tenant.id,
        planId: plan.id,
        billingCycle: SubscriptionBillingCycle.MONTHLY,
        currentPeriodStart: '2026-10-01',
        currentPeriodEnd: '2026-10-31',
      }),
    );
    fixture.subscriptionId = subscription.id;
    ownerToken = await keycloak.signAccessToken({
      sub: ownerSubject,
      roles: ['WorkspaceOwner'],
      tenantId: tenant.id,
    });
  });

  afterAll(async () => {
    let cleanupError: unknown;
    const attemptCleanup = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        cleanupError ??= error;
      }
    };

    try {
      if (controlDataSource.isInitialized) {
        if (fixture.tenantId) {
          await attemptCleanup(() =>
            controlDataSource.query('DELETE FROM "payment_submission" WHERE "tenant_id" = $1', [
              fixture.tenantId,
            ]),
          );
        }
        if (fixture.subscriptionId) {
          await attemptCleanup(() =>
            controlDataSource.query('DELETE FROM "subscription" WHERE "id" = $1', [
              fixture.subscriptionId,
            ]),
          );
        }
        if (fixture.tenantId) {
          await attemptCleanup(() =>
            controlDataSource.query('DELETE FROM "tenant" WHERE "id" = $1', [fixture.tenantId]),
          );
        }
        if (fixture.accountId) {
          await attemptCleanup(() =>
            controlDataSource.query('DELETE FROM "account" WHERE "id" = $1', [fixture.accountId]),
          );
        }
        if (fixture.planId) {
          await attemptCleanup(() =>
            controlDataSource.query('DELETE FROM "plan" WHERE "id" = $1', [fixture.planId]),
          );
        }
      }
    } finally {
      await app?.close();
      await keycloak?.close();
      if (controlDataSource.isInitialized) {
        await controlDataSource.destroy();
      }
      restoreEnvironment('KEYCLOAK_ISSUER', originalAuthEnvironment.issuer);
      restoreEnvironment('KEYCLOAK_API_AUDIENCE', originalAuthEnvironment.audience);
      restoreEnvironment('KEYCLOAK_JWKS_URI', originalAuthEnvironment.jwksUri);
    }

    if (cleanupError) {
      throw cleanupError;
    }
  });

  async function submissionCount(): Promise<number> {
    if (!fixture.tenantId) {
      throw new Error('T059 fixture was not initialized');
    }
    const [{ count }] = await controlDataSource.query(
      'SELECT count(*)::int AS count FROM "payment_submission" WHERE "tenant_id" = $1',
      [fixture.tenantId],
    );
    return count as number;
  }

  it('rejects an unsupported proof type with 422 and creates no PaymentSubmission row', async () => {
    expect(await submissionCount()).toBe(0);

    const response = await request(app.getHttpServer())
      .post(PAYMENT_SUBMISSIONS_PATH)
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('bankReference', 'T059-UNSUPPORTED-TYPE')
      .attach('proofFile', Buffer.from('T059 private executable fixture'), {
        filename: 'proof.txt',
        contentType: 'text/plain',
      })
      .expect(422);

    expect(JSON.stringify(response.body.message)).toMatch(
      /unsupported.{0,30}(file )?(type|format)|(file )?(type|format).{0,30}(not supported|not allowed|unsupported)/i,
    );
    expect(await submissionCount()).toBe(0);
  });

  it('rejects a proof over 10 MiB with 422 and creates no PaymentSubmission row', async () => {
    expect(await submissionCount()).toBe(0);

    const response = await request(app.getHttpServer())
      .post(PAYMENT_SUBMISSIONS_PATH)
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('bankReference', 'T059-OVER-SIZE')
      .attach('proofFile', Buffer.alloc(MAX_PAYMENT_PROOF_BYTES + 1, 0x41), {
        filename: 'proof.pdf',
        contentType: 'application/pdf',
      })
      .expect(422);

    expect(JSON.stringify(response.body.message)).toMatch(/size|too large|maximum|limit|exceeds/i);
    expect(await submissionCount()).toBe(0);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
