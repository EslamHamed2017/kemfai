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
  emailVerificationJobId,
} from '../../src/common/queues/queue-names';
import { redisConnectionFromUrl } from '../../src/common/queues/redis-connection';
import { DUPLICATE_EMAIL_GENERIC_MESSAGE } from '../../src/modules/accounts/accounts.service';

/**
 * T028 + T032 acceptance, end to end against a real Nest app, real Postgres (unique email
 * index as the idempotency anchor), and real Redis/BullMQ (email.send_verification jobs).
 *
 * Closes every reviewer finding from the two rejected ticks of 2026-09-19:
 *   - 00:37 #1  plan re-validation also covers the unverified-duplicate/resend path;
 *   - 00:37 #2  signup is failure-atomic + reliably audited (compensation, ordering,
 *               concurrency collapses on the DB constraint, no uncontrolled 500s);
 *   - 00:57 #1  missing/null password & every other ill-formed body → 422, never a 500;
 *   - 00:57 #2  the incomplete accounts module sits behind the `module.accounts`
 *               FeatureFlag (Constitution Principle VI), toggled by data, not a deploy;
 *   - 00:57 #3  no Redis/DB debris: every job/row this suite creates is removed again, so
 *               the full integration run stays green (queues-registration asserts the
 *               per-entity queues are empty).
 *
 * Cleanup is scoped to exactly what this suite created (suite email prefix + tracked ids),
 * never an unscoped DELETE — the control DB/Redis are shared with sibling suites.
 */

const SUITE_EMAIL_PREFIX = 't032-signup';

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
  // Feature row is provided by the SeedAccountsFeatureFlag migration (or re-created here if
  // a sibling suite's feature cleanup cascaded it away); the FLAG ROW is the config knob.
  await controlDataSource.query(
    `INSERT INTO "feature" ("id", "key", "display_name", "kind")
     VALUES (gen_random_uuid(), $1, 'Accounts & signup (US1)', 'module')
     ON CONFLICT ("key") DO NOTHING`,
    [ACCOUNTS_FEATURE_KEY],
  );
  await controlDataSource.query(
    `INSERT INTO "feature_flag" ("feature_key", "enabled", "notes")
     VALUES ($1, $2, 't032 test toggle')
     ON CONFLICT ("feature_key") DO UPDATE SET "enabled" = EXCLUDED."enabled"`,
    [ACCOUNTS_FEATURE_KEY, enabled],
  );
}

describe('POST /accounts/signup (T032 implementation + T028 acceptance, HTTP integration)', () => {
  let app: INestApplication;
  let rateLimiter: PublicAccountsRateLimiter;
  let fakeKeycloakUsers: FakeKeycloakUsers;
  let suiteEmailQueue: Queue;
  const createdPlanIds: string[] = [];
  const createdAccountIds: string[] = [];
  let suiteCreatedFeatureRow = false;

  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    // The signup surface under test must be reachable for the bulk of the suite; each
    // gating test flips the row itself. Note whether WE created the Feature row so
    // cleanup leaves migration-seeded state untouched.
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
  });

  beforeEach(() => {
    rateLimiter.clear();
  });

  afterAll(async () => {
    // --- Redis: remove only this suite's email.send_verification jobs (00:57 finding 3:
    // queues-registration.integration-spec asserts this queue is EMPTY). Jobs are keyed
    // accountId.tokenVersion and carry the suite-prefixed email in their payload.
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

    // --- Postgres: only this suite's rows.
    if (createdAccountIds.length > 0) {
      const ids = createdAccountIds.splice(0, createdAccountIds.length);
      await controlDataSource.query('DELETE FROM "audit_event" WHERE "subject_id" = ANY($1)', [
        ids,
      ]);
      await controlDataSource.query('DELETE FROM "account" WHERE "id" = ANY($1)', [ids]);
    }
    if (createdPlanIds.length > 0) {
      await controlDataSource.query('DELETE FROM "plan" WHERE "id" = ANY($1)', [
        createdPlanIds.splice(0, createdPlanIds.length),
      ]);
    }
    // Restore the flag to the migration's shipped default (hidden): the suite enabled it
    // only for its own tests. Drop the Feature row only if this suite created it.
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

  async function createPlan(published = true): Promise<Plan> {
    const planRepo = controlDataSource.getRepository(Plan);
    const plan = await planRepo.save(
      planRepo.create({
        name: `plan-${randomUUID()}`,
        published,
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

  async function accountRows(email: string): Promise<Account[]> {
    return controlDataSource.getRepository(Account).find({ where: { email } });
  }

  async function auditRowsFor(accountId: string): Promise<{ action: string; payload: unknown }[]> {
    return controlDataSource.query(
      'SELECT "action", "payload" FROM "audit_event" WHERE "subject_id" = $1 ORDER BY "occurred_at"',
      [accountId],
    );
  }

  async function verificationJobs(accountId: string): Promise<{ id: string; data: unknown }[]> {
    const jobs = await suiteEmailQueue.getJobs(
      ['wait', 'waiting', 'delayed', 'active', 'completed', 'failed'],
      0,
      1000,
    );
    return jobs
      .filter((job) => job.data?.accountId === accountId)
      .map((job) => ({ id: job.id as string, data: job.data }));
  }

  async function jobsForEmail(email: string): Promise<number> {
    const jobs = await suiteEmailQueue.getJobs(
      ['wait', 'waiting', 'delayed', 'active', 'completed', 'failed'],
      0,
      1000,
    );
    return jobs.filter((job) => job.data?.email === email).length;
  }

  describe('runtime DTO validation — 422, never an uncontrolled 500 (review 00:57 finding 1)', () => {
    it.each([
      ['missing password', { password: undefined }],
      ['null password', { password: null }],
      ['too-short (weak) password', { password: 'short' }],
      ['malformed email', { email: 'not-an-email' }],
      ['non-uuid planId', { planId: 'not-a-uuid' }],
      ['invalid billingCycle', { billingCycle: 'quarterly' }],
      ['acceptedTerms false', { acceptedTerms: false }],
      ['acceptedTerms missing', { acceptedTerms: undefined }],
      [
        'completely empty body',
        {
          email: undefined,
          password: undefined,
          planId: undefined,
          billingCycle: undefined,
          acceptedTerms: undefined,
        },
      ],
    ])('returns 422 for %s and creates nothing', async (_label, override) => {
      const plan = await createPlan(true);
      const email = suiteEmail('validation');
      const body = { ...validBody(email, plan.id), ...override };

      const response = await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(body)
        .expect(422);
      expect(response.body.statusCode).toBe(422);

      expect(await accountRows(email)).toHaveLength(0);
      expect(fakeKeycloakUsers.userByEmail(email)).toBeUndefined();
      expect(await jobsForEmail(email)).toBe(0);
    });
  });

  describe('feature-flag gate — Constitution Principle VI (review 00:57 finding 2)', () => {
    it('hides signup with 404 and zero side effects while module.accounts is disabled, then exposes it by a pure data change', async () => {
      const plan = await createPlan(true);
      const email = suiteEmail('flagged');

      await setAccountsFlag(false);
      try {
        await request(app.getHttpServer())
          .post('/accounts/signup')
          .send(validBody(email, plan.id))
          .expect(404);

        expect(await accountRows(email)).toHaveLength(0);
        expect(fakeKeycloakUsers.userByEmail(email)).toBeUndefined();

        // Flipping the row is a data act — the running app picks it up with no redeploy.
        await setAccountsFlag(true);
        const enabled = await request(app.getHttpServer())
          .post('/accounts/signup')
          .send(validBody(email, plan.id))
          .expect(201);
        trackAccount(enabled.body.accountId as string);
        expect(await accountRows(email)).toHaveLength(1);
      } finally {
        await setAccountsFlag(true); // suite default for subsequent tests
      }
    });
  });

  describe('happy path (T032, Acceptance Scenario 1.2)', () => {
    it('creates ONE unverified account with the plan/cycle carried, the Keycloak user, the account.created audit event, and one deduped verification job', async () => {
      const plan = await createPlan(true);
      const email = suiteEmail('happy');

      const response = await request(app.getHttpServer())
        .post('/accounts/signup')
        .send({ ...validBody(email, plan.id), billingCycle: 'annual' })
        .expect(201);
      const accountId = trackAccount(response.body.accountId);
      expect(accountId).toBeDefined();

      const rows = await accountRows(email);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: accountId,
        email, // stored normalized (citext + service-side lowercasing)
        emailVerified: false,
        mfaEnrolled: false,
        selectedPlanId: plan.id,
        selectedBillingCycle: 'annual',
      });
      expect(rows[0].keycloakUserId).toBeDefined();

      const keycloakUser = fakeKeycloakUsers.userByEmail(email);
      expect(keycloakUser).toBeDefined();
      expect(keycloakUser?.id).toBe(rows[0].keycloakUserId);
      expect(keycloakUser?.requiredActions).toContain('VERIFY_EMAIL');

      const audits = await auditRowsFor(accountId);
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('account.created');
      expect(audits[0].payload).toEqual({ plan_id: plan.id, billing_cycle: 'annual' });

      const jobs = await verificationJobs(accountId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(
        emailVerificationJobId(accountId, (jobs[0].data as { tokenVersion: string }).tokenVersion),
      );
    });
  });

  describe('plan re-validation (Edge Cases; review 00:37 finding 1)', () => {
    it('422s a NEW email whose plan is unpublished/unknown, creating nothing', async () => {
      const unpublished = await createPlan(false);
      const email = suiteEmail('plan-new');
      await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validBody(email, unpublished.id))
        .expect(422);
      const unknownPlan = await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validBody(email, randomUUID()))
        .expect(422);
      expect(unknownPlan.body.message).toContain('no longer available');

      expect(await accountRows(email)).toHaveLength(0);
      expect(fakeKeycloakUsers.userByEmail(email)).toBeUndefined();
      expect(await jobsForEmail(email)).toBe(0);
    });

    it('422s an UNVERIFIED DUPLICATE whose plan is no longer published — prompting re-selection instead of 201 + another email', async () => {
      const plan = await createPlan(true);
      const email = suiteEmail('plan-stale');

      const first = await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validBody(email, plan.id))
        .expect(201);
      const accountId = trackAccount(first.body.accountId);
      const jobsAfterFirst = await verificationJobs(accountId);

      const planRepo = controlDataSource.getRepository(Plan);
      await planRepo.update({ id: plan.id }, { published: false });

      await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validBody(email, plan.id))
        .expect(422);

      expect(await accountRows(email)).toHaveLength(1); // still exactly one row
      expect(await verificationJobs(accountId)).toHaveLength(jobsAfterFirst.length); // no new job
    });
  });

  describe('duplicate email handling (T028, Acceptance Scenario 1.6 + Edge Cases)', () => {
    it('already-verified email → generic 409, exactly one Account row, no second Keycloak user, no new audit/job', async () => {
      const plan = await createPlan(true);
      const email = suiteEmail('verified-dup');

      const first = await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validBody(email, plan.id))
        .expect(201);
      const accountId = trackAccount(first.body.accountId);

      // Simulate the (T033-owned) verification completing.
      await controlDataSource
        .getRepository(Account)
        .update({ id: accountId }, { emailVerified: true });

      const second = await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validBody(email, plan.id))
        .expect(409);
      expect(second.body.message).toBe(DUPLICATE_EMAIL_GENERIC_MESSAGE);

      expect(await accountRows(email)).toHaveLength(1); // T028: exactly one row
      expect(fakeKeycloakUsers.survivingUsers().filter((u) => u.email === email)).toHaveLength(1);
      expect(
        (await auditRowsFor(accountId)).filter((row) => row.action === 'account.created'),
      ).toHaveLength(1);
      expect(await verificationJobs(accountId)).toHaveLength(1);
    });

    it('unverified email → 201 with the SAME accountId, still one row/user, and a SECOND verification job (distinct token version)', async () => {
      const plan = await createPlan(true);
      const email = suiteEmail('unverified-dup');

      const first = await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validBody(email, plan.id))
        .expect(201);
      const accountId = trackAccount(first.body.accountId);

      const second = await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validBody(email, plan.id))
        .expect(201);
      expect(second.body.accountId).toBe(accountId); // same account, not a second row

      expect(await accountRows(email)).toHaveLength(1); // T028: exactly one row
      expect(fakeKeycloakUsers.survivingUsers().filter((u) => u.email === email)).toHaveLength(1);
      expect(
        (await auditRowsFor(accountId)).filter((row) => row.action === 'account.created'),
      ).toHaveLength(1);

      const jobs = await verificationJobs(accountId);
      expect(jobs).toHaveLength(2); // original send + resend
      expect(new Set(jobs.map((job) => job.id)).size).toBe(2); // distinct dedupe ids (events.md)
    });
  });

  describe('failure-atomicity and auditability (review 00:37 finding 2)', () => {
    it('Keycloak creation failure → controlled 503, no Account row, no Keycloak user, no audit, no job', async () => {
      const plan = await createPlan(true);
      const email = suiteEmail('kc-fail');

      fakeKeycloakUsers.unavailable();
      await request(app.getHttpServer())
        .post('/accounts/signup')
        .send(validBody(email, plan.id))
        .expect(503);

      expect(await accountRows(email)).toHaveLength(0);
      expect(fakeKeycloakUsers.userByEmail(email)).toBeUndefined();
      expect(await jobsForEmail(email)).toBe(0);
    });

    it('audit-write failure → controlled 503 and FULL compensation (Keycloak user deleted, row gone, no job)', async () => {
      const plan = await createPlan(true);
      const email = suiteEmail('audit-fail');
      const deletesBefore = fakeKeycloakUsers.deletedUserIds.length;

      const auditSpy = jest
        .spyOn(AuditService.prototype, 'recordAccountCreated')
        .mockRejectedValueOnce(new Error('audit insert failed'));
      try {
        await request(app.getHttpServer())
          .post('/accounts/signup')
          .send(validBody(email, plan.id))
          .expect(503);
      } finally {
        auditSpy.mockRestore();
      }

      expect(await accountRows(email)).toHaveLength(0);
      expect(fakeKeycloakUsers.userByEmail(email)).toBeUndefined();
      expect(fakeKeycloakUsers.deletedUserIds.length).toBe(deletesBefore + 1); // Keycloak user compensated
      expect(await jobsForEmail(email)).toBe(0);
    });

    it('concurrent same-email signups collapse to exactly one row and one Keycloak user (DB constraint is the anchor)', async () => {
      const plan = await createPlan(true);
      const email = suiteEmail('concurrent');

      const responses = await Promise.all([
        request(app.getHttpServer()).post('/accounts/signup').send(validBody(email, plan.id)),
        request(app.getHttpServer()).post('/accounts/signup').send(validBody(email, plan.id)),
        request(app.getHttpServer()).post('/accounts/signup').send(validBody(email, plan.id)),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(201); // idempotent: every caller is told the account exists
      }
      const accountIds = new Set(responses.map((r) => r.body.accountId as string));
      expect(accountIds.size).toBe(1);
      trackAccount(responses[0].body.accountId as string);

      expect(await accountRows(email)).toHaveLength(1); // T028: exactly one row, even under race
      expect(fakeKeycloakUsers.survivingUsers().filter((u) => u.email === email)).toHaveLength(1);
      const accountId = responses[0].body.accountId as string;
      expect(
        (await auditRowsFor(accountId)).filter((r) => r.action === 'account.created'),
      ).toHaveLength(1);
      const jobs = await verificationJobs(accountId);
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      expect(new Set(jobs.map((job) => job.id)).size).toBe(jobs.length);
    });

    it('email enqueue failure does NOT fail signup — account + audit persist (events.md: job "does not block signup response")', async () => {
      const plan = await createPlan(true);
      const email = suiteEmail('queue-fail');

      const injectedQueue = app.get<Queue>(getQueueToken(QUEUE_EMAIL_SEND_VERIFICATION));
      const addSpy = jest
        .spyOn(injectedQueue, 'add')
        .mockRejectedValueOnce(new Error('redis down'));
      try {
        const response = await request(app.getHttpServer())
          .post('/accounts/signup')
          .send(validBody(email, plan.id))
          .expect(201);
        const accountId = trackAccount(response.body.accountId);

        expect(await accountRows(email)).toHaveLength(1);
        expect(fakeKeycloakUsers.userByEmail(email)).toBeDefined();
        expect(
          (await auditRowsFor(accountId)).filter((r) => r.action === 'account.created'),
        ).toHaveLength(1);
      } finally {
        addSpy.mockRestore();
      }
    });
  });
});
