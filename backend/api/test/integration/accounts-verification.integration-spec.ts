import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { AuditService } from '../../src/modules/audit/audit.service';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { KEYCLOAK_USER_PROVISIONER } from '../../src/integrations/keycloak/keycloak-user-provisioner';
import { ACCOUNTS_FEATURE_KEY } from '../../src/modules/accounts/accounts.controller';
import { PublicAccountsRateLimiter } from '../../src/modules/accounts/public-accounts-rate-limit';
import { FakeKeycloakUsers } from '../support/fake-keycloak-users';
import {
  QUEUE_EMAIL_SEND_VERIFICATION,
  QUEUE_TENANT_PROVISION,
} from '../../src/common/queues/queue-names';
import { redisConnectionFromUrl } from '../../src/common/queues/redis-connection';
import { hashVerificationToken } from '../../src/modules/accounts/tokens/email-verification-token';

/**
 * T029 + T033 acceptance, end to end against a real Nest app, real Postgres (token
 * registry + audit) and real Redis/BullMQ (email.send_verification payloads carrying the
 * raw link token; tenant.provision jobs keyed by the bare account_id).
 *
 * Covers the FR-021/Edge Cases link lifecycle precisely:
 *   - only the MOST RECENTLY ISSUED, unexpired, unconsumed link is honored;
 *   - reusing a consumed link, an expired link, an unknown token, or a link superseded by
 *     a newer issuance each returns 410 with a distinct, actionable reason;
 *   - success is failure-atomic (Keycloak mirror / audit failures roll back to a
 *     retryable state with the SAME link) and idempotent (concurrent replays of one link
 *     produce exactly one verification, one audit event, one provisioning job).
 *
 * Cleanup is scoped to exactly what this suite created (suite email prefix + tracked
 * account/plan ids) in both Postgres and Redis — queues-registration asserts the
 * per-entity queues are empty, so tenant.provision jobs are removed by their account-keyed
 * job ids.
 */

const SUITE_EMAIL_PREFIX = 't033-verify';

function suiteEmail(slug: string): string {
  return `${SUITE_EMAIL_PREFIX}-${slug}-${randomUUID()}@example.com`;
}

function validBody(email: string, planId: string) {
  return {
    email,
    password: 'a-very-strong-password',
    planId,
    billingCycle: 'monthly',
    acceptedTerms: true,
  };
}

async function setAccountsFlag(enabled: boolean): Promise<void> {
  await controlDataSource.query(
    `INSERT INTO "feature" ("id", "key", "display_name", "kind")
     VALUES (gen_random_uuid(), $1, 'Accounts & signup (US1)', 'module')
     ON CONFLICT ("key") DO NOTHING`,
    [ACCOUNTS_FEATURE_KEY],
  );
  await controlDataSource.query(
    `INSERT INTO "feature_flag" ("feature_key", "enabled", "notes")
     VALUES ($1, $2, 't033 test toggle')
     ON CONFLICT ("feature_key") DO UPDATE SET "enabled" = EXCLUDED."enabled"`,
    [ACCOUNTS_FEATURE_KEY, enabled],
  );
}

interface EmailJobData {
  accountId: string;
  email: string;
  tokenVersion: string;
  token: string;
}

describe('POST /accounts/verify-email (T033 implementation + T029 acceptance, HTTP integration)', () => {
  let app: INestApplication;
  let rateLimiter: PublicAccountsRateLimiter;
  let fakeKeycloakUsers: FakeKeycloakUsers;
  let suiteEmailQueue: Queue;
  let suiteTenantProvisionQueue: Queue;
  const createdPlanIds: string[] = [];
  const createdAccountIds: string[] = [];
  let suiteCreatedFeatureRow = false;

  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    const existingFeature = await controlDataSource.query(
      'SELECT 1 FROM "feature" WHERE "key" = $1',
      [ACCOUNTS_FEATURE_KEY],
    );
    suiteCreatedFeatureRow = existingFeature.length === 0;
    await setAccountsFlag(true);

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
    // --- Redis: remove only this suite's jobs (per-entity queues must end empty).
    const emailJobs = await suiteEmailQueue.getJobs(
      ['wait', 'waiting', 'delayed', 'active', 'completed', 'failed'],
      0,
      1000,
    );
    for (const job of emailJobs) {
      if (
        typeof job.data?.email === 'string' &&
        job.data.email.startsWith(`${SUITE_EMAIL_PREFIX}-`)
      ) {
        await suiteEmailQueue.remove(job.id as string);
      }
    }
    await suiteEmailQueue.close();

    for (const accountId of createdAccountIds) {
      await suiteTenantProvisionQueue.remove(accountId); // job id IS the account_id
    }
    await suiteTenantProvisionQueue.close();

    // --- Postgres: only this suite's rows.
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
    await controlDataSource.query(
      'UPDATE "feature_flag" SET "enabled" = false WHERE "feature_key" = $1',
      [ACCOUNTS_FEATURE_KEY],
    );
    if (suiteCreatedFeatureRow) {
      await controlDataSource.query('DELETE FROM "feature_flag" WHERE "feature_key" = $1', [
        ACCOUNTS_FEATURE_KEY,
      ]);
      await controlDataSource.query('DELETE FROM "feature" WHERE "key" = $1', [
        ACCOUNTS_FEATURE_KEY,
      ]);
    }

    await app.close();
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
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

  async function signupFor(email: string, planId: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/accounts/signup')
      .send(validBody(email, planId))
      .expect(201);
    createdAccountIds.push(response.body.accountId);
    return response.body.accountId as string;
  }

  /** Raw link tokens issued for an account, oldest first (job.timestamp order). */
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

  async function accountRow(accountId: string): Promise<Account | null> {
    return controlDataSource.getRepository(Account).findOne({ where: { id: accountId } });
  }

  async function auditActionsFor(accountId: string): Promise<string[]> {
    const rows = await controlDataSource.query(
      'SELECT "action" FROM "audit_event" WHERE "subject_id" = $1 ORDER BY "occurred_at"',
      [accountId],
    );
    return rows.map((row: { action: string }) => row.action);
  }

  async function provisionJob(accountId: string): Promise<unknown> {
    return suiteTenantProvisionQueue.getJob(accountId);
  }

  async function tokenRowFor(token: string): Promise<{
    token_hash: string;
    consumed_at: Date | null;
    expires_at: Date;
  } | null> {
    const rows = await controlDataSource.query(
      'SELECT "token_hash", "consumed_at", "expires_at" FROM "email_verification_token" WHERE "token_hash" = $1',
      [hashVerificationToken(token)],
    );
    return rows[0] ?? null;
  }

  function verify(token: string) {
    return request(app.getHttpServer()).post('/accounts/verify-email').send({ token });
  }

  describe('happy path (T033, Acceptance Scenario 1.3)', () => {
    it('verifies the account, mirrors Keycloak, audits, and enqueues tenant.provision keyed by the account_id', async () => {
      const plan = await createPlan();
      const email = suiteEmail('happy');
      const accountId = await signupFor(email, plan.id);
      const [token] = await issuedTokens(accountId);
      expect(token).toBeDefined();

      // The registry stores ONLY the hash — the raw token never reaches the DB.
      const stored = await tokenRowFor(token);
      expect(stored).not.toBeNull();
      expect(stored?.token_hash).toBe(hashVerificationToken(token));

      const response = await verify(token).expect(200);
      expect(response.body).toEqual({ accountId });

      expect((await accountRow(accountId))?.emailVerified).toBe(true);

      const keycloakUser = fakeKeycloakUsers.userByEmail(email);
      expect(keycloakUser?.emailVerified).toBe(true);
      expect(keycloakUser?.requiredActions).not.toContain('VERIFY_EMAIL');

      expect(await auditActionsFor(accountId)).toEqual([
        'account.created',
        'account.email_verified',
      ]);
      expect(await provisionJob(accountId)).toBeDefined();

      // One-way state (data-model "Account"): a later signup with the now-verified email
      // gets the generic Scenario 1.6 rejection.
      await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validBody(email, plan.id))
        .expect(409);
    });
  });

  describe('token reuse (Edge Case: link used twice)', () => {
    it('second use of the same link → 410 used, no second audit event, no second provisioning job', async () => {
      const plan = await createPlan();
      const accountId = await signupFor(suiteEmail('reuse'), plan.id);
      const [token] = await issuedTokens(accountId);

      await verify(token).expect(200);
      const second = await verify(token).expect(410);
      expect(second.body.reason).toBe('used');

      const audits = await auditActionsFor(accountId);
      expect(audits.filter((action) => action === 'account.email_verified')).toHaveLength(1);
      expect(await provisionJob(accountId)).toBeDefined(); // still the single job
    });
  });

  describe('supersession (T029, FR-021: only the most recently issued link is honored)', () => {
    it('a newer issuance invalidates the older link — before AND after the newer link is consumed', async () => {
      const plan = await createPlan();
      const email = suiteEmail('supersede');
      const accountId = await signupFor(email, plan.id);

      // Re-issuance via the unverified-duplicate resend path (T028/T032; T034 will reuse it).
      await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validBody(email, plan.id))
        .expect(201);

      const tokens = await issuedTokens(accountId);
      expect(tokens).toHaveLength(2);
      const [olderToken, newerToken] = tokens;

      const older = await verify(olderToken).expect(410);
      expect(older.body.reason).toBe('superseded');

      expect((await accountRow(accountId))?.emailVerified).toBe(false);
      expect(await auditActionsFor(accountId)).toEqual(['account.created']);

      await verify(newerToken).expect(200);

      // The older link stays dead after the newer one is consumed.
      const olderAfter = await verify(olderToken).expect(410);
      expect(['superseded', 'used']).toContain(olderAfter.body.reason);
    });
  });

  describe('expired and invalid tokens (Edge Cases, FR-021)', () => {
    it('an expired link → 410 expired, nothing consumed, no provisioning', async () => {
      const plan = await createPlan();
      const accountId = await signupFor(suiteEmail('expired'), plan.id);
      const [token] = await issuedTokens(accountId);

      await controlDataSource.query(
        `UPDATE "email_verification_token" SET "expires_at" = now() - interval '1 minute' WHERE "token_hash" = $1`,
        [hashVerificationToken(token)],
      );

      const response = await verify(token).expect(410);
      expect(response.body.reason).toBe('expired');

      expect((await accountRow(accountId))?.emailVerified).toBe(false);
      expect(await provisionJob(accountId)).toBeUndefined();
      expect(await auditActionsFor(accountId)).toEqual(['account.created']);
    });

    it('an unknown token value → 410 invalid, zero side effects', async () => {
      const response = await verify('totally-unknown-token-value').expect(410);
      expect(response.body.reason).toBe('invalid');
    });

    it.each([
      ['missing token', { token: undefined }],
      ['empty token', { token: '' }],
      ['non-string token', { token: 12345 }],
    ])('malformed body (%s) → 422, never an uncontrolled 500', async (_label, body) => {
      const response = await request(app.getHttpServer())
        .post('/accounts/verify-email')
        .send(body)
        .expect(422);
      expect(response.body.statusCode).toBe(422);
    });
  });

  describe('failure atomicity (T032 discipline applied to verification)', () => {
    it('Keycloak mirror failure → 503 with the token untouched; the SAME link then succeeds on retry', async () => {
      const plan = await createPlan();
      const accountId = await signupFor(suiteEmail('kc-fail'), plan.id);
      const [token] = await issuedTokens(accountId);

      fakeKeycloakUsers.failNextMarkVerified = new Error('fake keycloak mirror down');
      await verify(token).expect(503);

      expect((await accountRow(accountId))?.emailVerified).toBe(false);
      expect((await tokenRowFor(token))?.consumed_at).toBeNull();
      expect(await provisionJob(accountId)).toBeUndefined();

      await verify(token).expect(200);
    });

    it('audit failure → 503 with FULL local compensation; the SAME link then succeeds on retry', async () => {
      const plan = await createPlan();
      const accountId = await signupFor(suiteEmail('audit-fail'), plan.id);
      const [token] = await issuedTokens(accountId);

      const auditSpy = jest
        .spyOn(AuditService.prototype, 'recordAccountEmailVerified')
        .mockRejectedValueOnce(new Error('audit insert failed'));
      try {
        await verify(token).expect(503);
      } finally {
        auditSpy.mockRestore();
      }

      expect((await accountRow(accountId))?.emailVerified).toBe(false); // flag rolled back
      expect((await tokenRowFor(token))?.consumed_at).toBeNull(); // token un-consumed
      expect(await provisionJob(accountId)).toBeUndefined();

      await verify(token).expect(200);
      expect(
        (await auditActionsFor(accountId)).filter((a) => a === 'account.email_verified'),
      ).toHaveLength(1);
    });

    it('provision enqueue failure → verification still succeeds (recovery is provisioning-retry, T045)', async () => {
      const plan = await createPlan();
      const accountId = await signupFor(suiteEmail('qfail'), plan.id);
      const [token] = await issuedTokens(accountId);

      const injectedQueue = app.get<Queue>(getQueueToken(QUEUE_TENANT_PROVISION));
      const addSpy = jest
        .spyOn(injectedQueue, 'add')
        .mockRejectedValueOnce(new Error('redis down'));
      try {
        await verify(token).expect(200);
      } finally {
        addSpy.mockRestore();
      }

      expect((await accountRow(accountId))?.emailVerified).toBe(true);
      expect(await auditActionsFor(accountId)).toContain('account.email_verified');
    });
  });

  describe('idempotency under concurrency (Constitution Principle VII)', () => {
    it('two concurrent verifications of the SAME link repeatedly yield exactly one 200, one 410, one audit event, one job', async () => {
      const plan = await createPlan();

      // A handful of fresh-token races catches driver-result-shape regressions without
      // turning this focused gate into a long-running stress test.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const accountId = await signupFor(suiteEmail(`concurrent-${attempt}`), plan.id);
        const [token] = await issuedTokens(accountId);

        const [first, second] = await Promise.all([verify(token), verify(token)]);
        expect([first.status, second.status].sort()).toEqual([200, 410]);

        expect((await accountRow(accountId))?.emailVerified).toBe(true);
        expect(
          (await auditActionsFor(accountId)).filter(
            (action) => action === 'account.email_verified',
          ),
        ).toHaveLength(1);
        expect(await provisionJob(accountId)).toBeDefined();
      }
    });
  });

  describe('feature-flag gate (Constitution Principle VI)', () => {
    it('hides verify-email with 404 while module.accounts is disabled', async () => {
      const plan = await createPlan();
      const accountId = await signupFor(suiteEmail('flagged'), plan.id);
      const [token] = await issuedTokens(accountId);

      await setAccountsFlag(false);
      try {
        await verify(token).expect(404);
        expect((await accountRow(accountId))?.emailVerified).toBe(false);
      } finally {
        await setAccountsFlag(true); // suite default for subsequent tests
      }
    });
  });
});
