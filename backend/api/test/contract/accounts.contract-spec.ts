import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { KEYCLOAK_USER_PROVISIONER } from '../../src/integrations/keycloak/keycloak-user-provisioner';
import { ACCOUNTS_FEATURE_KEY } from '../../src/modules/accounts/accounts.controller';
import { PublicAccountsRateLimiter } from '../../src/modules/accounts/public-accounts-rate-limit';
import { FakeKeycloakUsers } from '../support/fake-keycloak-users';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';
import {
  QUEUE_EMAIL_SEND_VERIFICATION,
  QUEUE_TENANT_PROVISION,
} from '../../src/common/queues/queue-names';
import { redisConnectionFromUrl } from '../../src/common/queues/redis-connection';
import { ContractCoverage, OpenApiContractValidator } from '../support/openapi-contract-validator';

/**
 * T027 — contract test for the five US1 accounts endpoints against the committed
 * `specs/001-saas-onboarding-shell/contracts/openapi.yaml`. Every documented response
 * code (including localized 429 responses) is exercised at least once; each response is checked
 * against whatever the contract actually declares for it (status codes always, plus a
 * body schema wherever one is declared — see OpenApiContractValidator).
 *
 * This is distinct from T028/T029/T034/T035's integration suites, which exhaustively
 * cover business-logic edge cases (idempotency, failure-atomicity, concurrency). This
 * suite's only job is: does the live HTTP surface match the contract's shape.
 *
 * Feature-flag state is captured before the suite runs and restored EXACTLY afterwards
 * (including "no row existed at all") rather than force-set to a fixed value — tests
 * must never overwrite admin-configured feature-flag state.
 */

const SUITE_EMAIL_PREFIX = 't027-contract';

function suiteEmail(slug: string): string {
  return `${SUITE_EMAIL_PREFIX}-${slug}-${randomUUID()}@example.com`;
}

function validSignupBody(email: string, planId: string) {
  return {
    email,
    password: 'a-very-strong-password',
    planId,
    billingCycle: 'monthly',
    acceptedTerms: true,
  };
}

interface FeatureFlagSnapshot {
  featureExisted: boolean;
  flagRow: { enabled: boolean; notes: string | null } | null;
}

async function captureAccountsFlagState(): Promise<FeatureFlagSnapshot> {
  const featureRows = await controlDataSource.query('SELECT 1 FROM "feature" WHERE "key" = $1', [
    ACCOUNTS_FEATURE_KEY,
  ]);
  const flagRows = await controlDataSource.query(
    'SELECT "enabled", "notes" FROM "feature_flag" WHERE "feature_key" = $1',
    [ACCOUNTS_FEATURE_KEY],
  );
  return {
    featureExisted: featureRows.length > 0,
    flagRow:
      flagRows.length > 0 ? { enabled: flagRows[0].enabled, notes: flagRows[0].notes } : null,
  };
}

async function enableAccountsFlagForSuite(): Promise<void> {
  await controlDataSource.query(
    `INSERT INTO "feature" ("id", "key", "display_name", "kind")
     VALUES (gen_random_uuid(), $1, 'Accounts & signup (US1)', 'module')
     ON CONFLICT ("key") DO NOTHING`,
    [ACCOUNTS_FEATURE_KEY],
  );
  await controlDataSource.query(
    `INSERT INTO "feature_flag" ("feature_key", "enabled", "notes")
     VALUES ($1, true, 't027 contract test toggle')
     ON CONFLICT ("feature_key") DO UPDATE SET "enabled" = true`,
    [ACCOUNTS_FEATURE_KEY],
  );
}

/**
 * Restores the feature/feature_flag rows to EXACTLY the state captured before this
 * suite ran — never a fixed "false", and never leaves behind a row this suite created
 * where none existed before (the defect a prior review round flagged in this suite).
 */
async function restoreAccountsFlagState(snapshot: FeatureFlagSnapshot): Promise<void> {
  if (snapshot.flagRow) {
    await controlDataSource.query(
      'UPDATE "feature_flag" SET "enabled" = $1, "notes" = $2 WHERE "feature_key" = $3',
      [snapshot.flagRow.enabled, snapshot.flagRow.notes, ACCOUNTS_FEATURE_KEY],
    );
  } else {
    await controlDataSource.query('DELETE FROM "feature_flag" WHERE "feature_key" = $1', [
      ACCOUNTS_FEATURE_KEY,
    ]);
  }
  if (!snapshot.featureExisted) {
    await controlDataSource.query('DELETE FROM "feature" WHERE "key" = $1', [ACCOUNTS_FEATURE_KEY]);
  }
}

interface EmailJobData {
  accountId: string;
  email: string;
  tokenVersion: string;
  token: string;
}

describe('Accounts contract (T027, HTTP integration against contracts/openapi.yaml)', () => {
  const issuer = 'http://127.0.0.1/realms/kemfai-customers-contract-test';
  const audience = 'kemfai-api-contract-test';

  let app: INestApplication;
  let keycloak: FakeKeycloak;
  let fakeKeycloakUsers: FakeKeycloakUsers;
  let suiteEmailQueue: Queue;
  let suiteTenantProvisionQueue: Queue;
  let flagSnapshot: FeatureFlagSnapshot;
  let rateLimiter: PublicAccountsRateLimiter;
  const validator = new OpenApiContractValidator();
  const coverage = new ContractCoverage(validator);
  const createdPlanIds: string[] = [];
  const createdAccountIds: string[] = [];

  beforeAll(async () => {
    keycloak = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;

    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    flagSnapshot = await captureAccountsFlagState();
    await enableAccountsFlagForSuite();

    fakeKeycloakUsers = new FakeKeycloakUsers();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KEYCLOAK_USER_PROVISIONER)
      .useValue(fakeKeycloakUsers)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    rateLimiter = app.get(PublicAccountsRateLimiter);

    suiteEmailQueue = new Queue(QUEUE_EMAIL_SEND_VERIFICATION, {
      connection: redisConnectionFromUrl(),
    });
    suiteTenantProvisionQueue = new Queue(QUEUE_TENANT_PROVISION, {
      connection: redisConnectionFromUrl(),
    });
  });

  beforeEach(() => {
    rateLimiter.clear();
  });

  afterAll(async () => {
    const jobs = await suiteEmailQueue.getJobs(
      ['wait', 'waiting', 'delayed', 'active', 'completed', 'failed'],
      0,
      1000,
    );
    for (const job of jobs) {
      if (
        typeof job.data?.email === 'string' &&
        job.data.email.startsWith(`${SUITE_EMAIL_PREFIX}-`)
      ) {
        await suiteEmailQueue.remove(job.id as string);
      }
    }
    await suiteEmailQueue.close();

    // tenant.provision jobs are keyed by the bare account_id (events.md) — the successful
    // verify-email test below enqueues one; removing a job id that was never created is a
    // no-op, so this is safe to run for every account this suite tracked.
    for (const accountId of createdAccountIds) {
      await suiteTenantProvisionQueue.remove(accountId);
    }
    await suiteTenantProvisionQueue.close();

    if (createdAccountIds.length > 0) {
      const ids = createdAccountIds.splice(0, createdAccountIds.length);
      await controlDataSource.query('DELETE FROM "audit_event" WHERE "subject_id" = ANY($1)', [
        ids,
      ]);
      await controlDataSource.query(
        'DELETE FROM "email_verification_token" WHERE "account_id" = ANY($1)',
        [ids],
      );
      await controlDataSource.query('DELETE FROM "account" WHERE "id" = ANY($1)', [ids]);
    }
    if (createdPlanIds.length > 0) {
      await controlDataSource.query('DELETE FROM "plan" WHERE "id" = ANY($1)', [
        createdPlanIds.splice(0, createdPlanIds.length),
      ]);
    }

    await restoreAccountsFlagState(flagSnapshot);

    await app.close();
    await keycloak.close();
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
    delete process.env.KEYCLOAK_ISSUER;
    delete process.env.KEYCLOAK_API_AUDIENCE;
    delete process.env.KEYCLOAK_JWKS_URI;
  });

  async function createPlan(): Promise<Plan> {
    const planRepo = controlDataSource.getRepository(Plan);
    const plan = await planRepo.save(
      planRepo.create({
        name: `plan-${randomUUID()}`,
        published: true,
        monthlyPrice: '10.00',
        annualPrice: '100.00',
        currency: 'USD',
      }),
    );
    createdPlanIds.push(plan.id);
    return plan;
  }

  function trackAccount(accountId: string): string {
    createdAccountIds.push(accountId);
    return accountId;
  }

  async function issuedTokens(accountId: string): Promise<string[]> {
    const jobs = await suiteEmailQueue.getJobs(
      ['wait', 'waiting', 'delayed', 'active', 'completed', 'failed'],
      0,
      1000,
    );
    return jobs
      .filter((job) => job.data?.accountId === accountId)
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
      .map((job) => (job.data as EmailJobData).token);
  }

  async function createVerifiedAuthenticatedAccount(): Promise<{
    account: Account;
    token: string;
  }> {
    const keycloakUserId = randomUUID();
    const email = suiteEmail('mfa');
    const accountRepo = controlDataSource.getRepository(Account);
    const account = await accountRepo.save(
      accountRepo.create({
        keycloakUserId,
        email,
        emailVerified: true,
        mfaEnrolled: false,
      }),
    );
    trackAccount(account.id);
    fakeKeycloakUsers.users.set(keycloakUserId, {
      id: keycloakUserId,
      email,
      emailVerified: true,
      requiredActions: [],
      hasOtpCredential: false,
    });
    const token = await keycloak.signAccessToken({ sub: keycloakUserId });
    return { account, token };
  }

  describe('POST /accounts/signup', () => {
    it('201: request body matches SignupRequest, response status matches the contract', async () => {
      const plan = await createPlan();
      const body = validSignupBody(suiteEmail('signup-201'), plan.id);
      validator.validateRequestBody('/accounts/signup', 'post', body);

      const response = await request(app.getHttpServer()).post('/accounts/signup').send(body);
      trackAccount(response.body.accountId as string);
      coverage.record('/accounts/signup', 'post', response.status, response.body);
      expect(response.status).toBe(201);
    });

    it('409: signup against an already-verified email', async () => {
      const plan = await createPlan();
      const email = suiteEmail('signup-409');
      const first = await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validSignupBody(email, plan.id))
        .expect(201);
      const accountId = trackAccount(first.body.accountId);
      await controlDataSource
        .getRepository(Account)
        .update({ id: accountId }, { emailVerified: true });

      const response = await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validSignupBody(email, plan.id));
      coverage.record('/accounts/signup', 'post', response.status, response.body);
      expect(response.status).toBe(409);
    });

    it('422: malformed body (weak password) never reaches account creation', async () => {
      const plan = await createPlan();
      const body = { ...validSignupBody(suiteEmail('signup-422'), plan.id), password: 'short' };

      const response = await request(app.getHttpServer()).post('/accounts/signup').send(body);
      coverage.record('/accounts/signup', 'post', response.status, response.body);
      expect(response.status).toBe(422);
    });

    it('429: rejects the sixth request in a minute with English retry metadata', async () => {
      const invalidBody = {
        ...validSignupBody(suiteEmail('signup-429'), randomUUID()),
        password: 'short',
      };
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app.getHttpServer()).post('/accounts/signup').send(invalidBody).expect(422);
      }

      const response = await request(app.getHttpServer())
        .post('/accounts/signup')
        .set('Accept-Language', 'en-US')
        .send(invalidBody);
      coverage.record('/accounts/signup', 'post', response.status, response.body);
      expect(response.status).toBe(429);
      expect(response.headers['content-language']).toBe('en');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      expect(response.body).toMatchObject({
        statusCode: 429,
        message: 'Too many attempts. Please try again later.',
        error: 'Too Many Requests',
      });
    });
  });

  describe('POST /accounts/verify-email', () => {
    it('200: consuming the link issued at signup', async () => {
      const plan = await createPlan();
      const email = suiteEmail('verify-200');
      const signup = await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validSignupBody(email, plan.id))
        .expect(201);
      const accountId = trackAccount(signup.body.accountId);
      const [token] = await issuedTokens(accountId);
      expect(token).toBeDefined();

      const body = { token };
      validator.validateRequestBody('/accounts/verify-email', 'post', body);

      const response = await request(app.getHttpServer()).post('/accounts/verify-email').send(body);
      coverage.record('/accounts/verify-email', 'post', response.status, response.body);
      expect(response.status).toBe(200);
    });

    it('410: an unknown token value', async () => {
      const response = await request(app.getHttpServer())
        .post('/accounts/verify-email')
        .send({ token: 'totally-unknown-token-value' });
      coverage.record('/accounts/verify-email', 'post', response.status, response.body);
      expect(response.status).toBe(410);
    });

    it('429: rejects the eleventh request in a minute with Arabic retry metadata', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await request(app.getHttpServer())
          .post('/accounts/verify-email')
          .send({ token: `unknown-rate-limit-token-${attempt}` })
          .expect(410);
      }

      const response = await request(app.getHttpServer())
        .post('/accounts/verify-email')
        .set('Accept-Language', 'ar-AE')
        .send({ token: 'unknown-rate-limit-token-denied' });
      coverage.record('/accounts/verify-email', 'post', response.status, response.body);
      expect(response.status).toBe(429);
      expect(response.headers['content-language']).toBe('ar');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      expect(response.body).toMatchObject({
        statusCode: 429,
        message: 'عدد المحاولات كبير جدًا. يُرجى المحاولة مرة أخرى لاحقًا.',
        error: 'Too Many Requests',
      });
    });
  });

  describe('POST /accounts/resend-verification', () => {
    it('202: sent regardless of whether the email is known (no account-existence leak)', async () => {
      const body = { email: suiteEmail('resend-202') };
      validator.validateRequestBody('/accounts/resend-verification', 'post', body);

      const response = await request(app.getHttpServer())
        .post('/accounts/resend-verification')
        .send(body);
      coverage.record('/accounts/resend-verification', 'post', response.status, response.body);
      expect(response.status).toBe(202);
    });
  });

  describe('POST /accounts/mfa/enroll', () => {
    it('200: begins TOTP enrollment for the authenticated, verified account', async () => {
      const { token } = await createVerifiedAuthenticatedAccount();

      const response = await request(app.getHttpServer())
        .post('/accounts/mfa/enroll')
        .set('Authorization', `Bearer ${token}`)
        .send();
      coverage.record('/accounts/mfa/enroll', 'post', response.status, response.body);
      expect(response.status).toBe(200);
    });
  });

  describe('POST /accounts/mfa/confirm', () => {
    it('200: confirms MFA once Keycloak reports an active TOTP credential', async () => {
      const { account, token } = await createVerifiedAuthenticatedAccount();
      fakeKeycloakUsers.completeTotpSetup(account.keycloakUserId);

      const response = await request(app.getHttpServer())
        .post('/accounts/mfa/confirm')
        .set('Authorization', `Bearer ${token}`)
        .send();
      coverage.record('/accounts/mfa/confirm', 'post', response.status, response.body);
      expect(response.status).toBe(200);
    });
  });

  describe('coverage (T027 acceptance criterion)', () => {
    it('every documented response code for each of these five operations was exercised', () => {
      coverage.assertFullCoverage('/accounts/signup', 'post');
      coverage.assertFullCoverage('/accounts/verify-email', 'post');
      coverage.assertFullCoverage('/accounts/resend-verification', 'post');
      coverage.assertFullCoverage('/accounts/mfa/enroll', 'post');
      coverage.assertFullCoverage('/accounts/mfa/confirm', 'post');
    });
  });
});
