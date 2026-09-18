import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { KEYCLOAK_USER_PROVISIONER } from '../../src/integrations/keycloak/keycloak-user-provisioner';
import { ACCOUNTS_FEATURE_KEY } from '../../src/modules/accounts/accounts.controller';
import { FakeKeycloakUsers } from '../support/fake-keycloak-users';
import {
  QUEUE_EMAIL_SEND_VERIFICATION,
  QUEUE_TENANT_PROVISION,
} from '../../src/common/queues/queue-names';
import { redisConnectionFromUrl } from '../../src/common/queues/redis-connection';

/**
 * T034 acceptance, end to end against a real Nest app, real Postgres (token registry +
 * audit) and real Redis/BullMQ (email.send_verification payloads).
 *
 * Covers Acceptance Scenario 1.5 / FR-021 precisely:
 *   - ALWAYS 202 with an empty body — byte-identical responses for unknown, unverified,
 *     and verified emails, so the endpoint leaks zero account-existence information;
 *   - for a known UNVERIFIED account, the fresh issuance invalidates every prior link
 *     (latest-token-wins) and the NEW link verifies; a chain of resends keeps only the
 *     last link alive;
 *   - unknown and verified emails produce no token rows, no email jobs, no audit events;
 *   - malformed bodies are the contract-wide 422; the module flag hides the route (404).
 *
 * Review findings this suite is designed against (2026-09-19 02:18): setup failures
 * must surface clearly (fail-fast preflight naming the exact connection target), and
 * afterAll must never mask a setup failure with a secondary TypeError — every cleanup
 * step is guarded so a partially-initialized suite still tears down cleanly.
 */

const SUITE_EMAIL_PREFIX = 't034-resend';

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

async function setAccountsFlag(enabled: boolean): Promise<void> {
  await controlDataSource.query(
    `INSERT INTO "feature" ("id", "key", "display_name", "kind")
     VALUES (gen_random_uuid(), $1, 'Accounts & signup (US1)', 'module')
     ON CONFLICT ("key") DO NOTHING`,
    [ACCOUNTS_FEATURE_KEY],
  );
  await controlDataSource.query(
    `INSERT INTO "feature_flag" ("feature_key", "enabled", "notes")
     VALUES ($1, $2, 't034 test toggle')
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

describe('POST /accounts/resend-verification (T034 implementation, HTTP integration)', () => {
  let app: INestApplication | undefined;
  let suiteEmailQueue: Queue | undefined;
  let suiteTenantProvisionQueue: Queue | undefined;
  const createdPlanIds: string[] = [];
  const createdAccountIds: string[] = [];
  let suiteCreatedFeatureRow = false;

  beforeAll(async () => {
    // Fail fast with the exact unreachable target instead of 11 opaque per-test errors.
    if (!controlDataSource.isInitialized) {
      try {
        await controlDataSource.initialize();
      } catch (error) {
        const { host, port, username, database } = controlDataSource.options as {
          host: string;
          port: number;
          username: string;
          database: string;
        };
        throw new Error(
          `T034 suite cannot reach the control DB at ${host}:${port} as "${username}" / db "${database}" ` +
            `(set CONTROL_DB_* env vars or start infra/docker/docker-compose.yml; ` +
            `convention: CONTROL_DB_HOST=localhost CONTROL_DB_USER=odoo ` +
            `CONTROL_DB_PASSWORD=kemfai_dev_pg CONTROL_DB_NAME=kemfai_control). Cause: ${String(error)}`,
        );
      }
    }
    await controlDataSource.runMigrations();

    const existingFeature = await controlDataSource.query(
      'SELECT 1 FROM "feature" WHERE "key" = $1',
      [ACCOUNTS_FEATURE_KEY],
    );
    suiteCreatedFeatureRow = existingFeature.length === 0;
    await setAccountsFlag(true);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KEYCLOAK_USER_PROVISIONER)
      .useValue(new FakeKeycloakUsers())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    suiteEmailQueue = new Queue(QUEUE_EMAIL_SEND_VERIFICATION, {
      connection: redisConnectionFromUrl(),
    });
    suiteTenantProvisionQueue = new Queue(QUEUE_TENANT_PROVISION, {
      connection: redisConnectionFromUrl(),
    });
  });

  afterAll(async () => {
    // Every step guarded: a failed beforeAll must not turn into a secondary TypeError
    // that masks the real setup failure (review finding 2026-09-19 02:18).
    if (suiteEmailQueue) {
      try {
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
      } catch {
        // Redis unreachable — nothing this suite created can be reached either.
      }
      try {
        await suiteEmailQueue.close();
      } catch {
        // already closed / connection dropped
      }
    }

    if (suiteTenantProvisionQueue) {
      try {
        // tenant.provision jobs are keyed by the bare account_id (events.md); removing
        // a job id that was never created is a no-op, so this is safe for all accounts.
        for (const accountId of createdAccountIds) {
          await suiteTenantProvisionQueue.remove(accountId);
        }
      } catch {
        // Redis unreachable — nothing this suite created can be reached either.
      }
      try {
        await suiteTenantProvisionQueue.close();
      } catch {
        // already closed / connection dropped
      }
    }

    if (controlDataSource.isInitialized) {
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
    }

    if (app) {
      await app.close();
    }
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
    const response = await request(app!.getHttpServer())
      .post('/accounts/signup')
      .send(validSignupBody(email, planId))
      .expect(201);
    createdAccountIds.push(response.body.accountId);
    return response.body.accountId as string;
  }

  /** Raw link tokens issued for an account, oldest first (job.timestamp order). */
  async function issuedTokens(accountId: string): Promise<string[]> {
    const jobs = await suiteEmailQueue!.getJobs(
      ['wait', 'waiting', 'delayed', 'active', 'completed', 'failed'],
      0,
      1000,
    );
    return jobs
      .filter((job) => job.data?.accountId === accountId)
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
      .map((job) => (job.data as EmailJobData).token);
  }

  async function tokenRowCount(accountId: string): Promise<number> {
    const rows = await controlDataSource.query(
      'SELECT count(*)::int AS n FROM "email_verification_token" WHERE "account_id" = $1',
      [accountId],
    );
    return rows[0].n;
  }

  async function auditActionsFor(accountId: string): Promise<string[]> {
    const rows = await controlDataSource.query(
      'SELECT "action" FROM "audit_event" WHERE "subject_id" = $1 ORDER BY "occurred_at"',
      [accountId],
    );
    return rows.map((row: { action: string }) => row.action);
  }

  function resend(email: string) {
    return request(app!.getHttpServer()).post('/accounts/resend-verification').send({ email });
  }

  describe('Acceptance Scenario 1.5 (FR-021): new link sent, prior links invalidated', () => {
    it('202 empty body; the ORIGINAL link is now superseded; the NEW link verifies', async () => {
      const plan = await createPlan();
      const email = suiteEmail('happy');
      const accountId = await signupFor(email, plan.id);
      const [originalToken] = await issuedTokens(accountId);
      expect(originalToken).toBeDefined();

      const response = await resend(email).expect(202);
      expect(response.text).toBe(''); // empty body — nothing to parse, nothing to leak

      const tokens = await issuedTokens(accountId);
      expect(tokens).toHaveLength(2);
      expect(tokens[1]).not.toBe(originalToken); // a FRESH link, not a replay

      // The prior link is invalidated...
      const superseded = await request(app!.getHttpServer())
        .post('/accounts/verify-email')
        .send({ token: originalToken })
        .expect(410);
      expect(superseded.body.reason).toBe('superseded');

      // ...and the new one carries the full T033 behavior.
      await request(app!.getHttpServer())
        .post('/accounts/verify-email')
        .send({ token: tokens[1] })
        .expect(200);
    });

    it('a chain of resends keeps ONLY the last link alive', async () => {
      const plan = await createPlan();
      const email = suiteEmail('chain');
      const accountId = await signupFor(email, plan.id);

      await resend(email).expect(202);
      await resend(email).expect(202);

      const tokens = await issuedTokens(accountId);
      expect(tokens).toHaveLength(3);

      await request(app!.getHttpServer())
        .post('/accounts/verify-email')
        .send({ token: tokens[0] })
        .expect(410);
      await request(app!.getHttpServer())
        .post('/accounts/verify-email')
        .send({ token: tokens[1] })
        .expect(410);
      await request(app!.getHttpServer())
        .post('/accounts/verify-email')
        .send({ token: tokens[2] })
        .expect(200);
    });

    it('the account stays unverified and unaudited beyond account.created — resend emits no audit event (events.md has none)', async () => {
      const plan = await createPlan();
      const email = suiteEmail('no-audit');
      const accountId = await signupFor(email, plan.id);

      await resend(email).expect(202);

      const rows = await controlDataSource.query(
        'SELECT "email_verified" FROM "account" WHERE "id" = $1',
        [accountId],
      );
      expect(rows[0].email_verified).toBe(false);
      expect(await auditActionsFor(accountId)).toEqual(['account.created']);
    });
  });

  describe('no account-existence leak (task AC: 202 regardless of whether the email exists)', () => {
    it('unknown email → 202 empty body, zero token rows, zero email jobs', async () => {
      const stranger = suiteEmail('unknown');
      const response = await resend(stranger).expect(202);
      expect(response.text).toBe('');

      const jobs = await suiteEmailQueue!.getJobs(
        ['wait', 'waiting', 'delayed', 'active', 'completed', 'failed'],
        0,
        1000,
      );
      expect(jobs.filter((job) => job.data?.email === stranger)).toHaveLength(0);
    });

    it('verified account → 202 empty body, no new issuance (a dead flow is never resurrected)', async () => {
      const plan = await createPlan();
      const email = suiteEmail('verified');
      const accountId = await signupFor(email, plan.id);
      const [token] = await issuedTokens(accountId);
      await request(app!.getHttpServer())
        .post('/accounts/verify-email')
        .send({ token })
        .expect(200);
      expect(await tokenRowCount(accountId)).toBe(1);

      await resend(email).expect(202);

      expect(await tokenRowCount(accountId)).toBe(1); // no second issuance
      expect((await issuedTokens(accountId)).length).toBe(1); // no second email job
    });

    it('unknown, unverified, and verified emails produce byte-identical responses', async () => {
      const plan = await createPlan();
      // Slugs stay short: the email local part must stay under the RFC 5321 64-char
      // limit that validator.js (IsEmail) enforces — suite prefix + slug + uuid.
      const unverifiedEmail = suiteEmail('par-un');
      const verifiedEmail = suiteEmail('par-ver');
      await signupFor(unverifiedEmail, plan.id);
      const accountId = await signupFor(verifiedEmail, plan.id);
      const [token] = await issuedTokens(accountId);
      await request(app!.getHttpServer())
        .post('/accounts/verify-email')
        .send({ token })
        .expect(200);

      const [unknown, unverified, verified] = await Promise.all([
        resend(suiteEmail('par-no')),
        resend(unverifiedEmail),
        resend(verifiedEmail),
      ]);
      expect(unknown.status).toBe(unverified.status);
      expect(unknown.text).toBe(unverified.text);
      expect(unknown.headers['content-type']).toBe(unverified.headers['content-type']);
      expect(verified.status).toBe(unverified.status);
      expect(verified.text).toBe(unverified.text);
      expect(verified.headers['content-type']).toBe(unverified.headers['content-type']);
    });
  });

  describe('email normalization parity with signup (T032 stored form)', () => {
    it('mixed-case input still resolves the account and issues a new link', async () => {
      const plan = await createPlan();
      const email = suiteEmail('normalize');
      const accountId = await signupFor(email, plan.id);

      await resend(email.toUpperCase()).expect(202);

      expect((await issuedTokens(accountId)).length).toBe(2);
    });
  });

  describe('malformed input (contract-wide 422, never an uncontrolled 500)', () => {
    it.each([
      ['missing email', {}],
      ['empty email', { email: '' }],
      ['non-string email', { email: 12345 }],
      ['ill-formed email', { email: 'not-an-email' }],
      [
        'space-padded email (pipe rejects before service normalization)',
        { email: '  owner@example.com  ' },
      ],
    ])('%s → 422', async (_label, body) => {
      const response = await request(app!.getHttpServer())
        .post('/accounts/resend-verification')
        .send(body)
        .expect(422);
      expect(response.body.statusCode).toBe(422);
    });
  });

  describe('feature-flag gate (Constitution Principle VI)', () => {
    it('hides resend-verification with 404 while module.accounts is disabled', async () => {
      await setAccountsFlag(false);
      try {
        await resend(suiteEmail('flagged')).expect(404);
      } finally {
        await setAccountsFlag(true); // suite default for subsequent tests
      }
    });
  });
});
