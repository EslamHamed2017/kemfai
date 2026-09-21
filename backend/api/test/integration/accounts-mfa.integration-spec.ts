import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { AuditService } from '../../src/modules/audit/audit.service';
import { KEYCLOAK_USER_PROVISIONER } from '../../src/integrations/keycloak/keycloak-user-provisioner';
import { ACCOUNTS_FEATURE_KEY } from '../../src/modules/accounts/accounts.controller';
import { FakeKeycloakUsers } from '../support/fake-keycloak-users';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

/**
 * T035 acceptance, end to end against a real Nest app, real Postgres, and a real (fake)
 * Keycloak JWKS endpoint for bearer-token verification.
 *
 * The headline coverage (2026-09-21 review finding) is failure-atomicity + linearizability
 * of `POST /accounts/mfa/confirm` under concurrency: `Account.mfaEnrolled` and its mandatory
 * `account.mfa_enrolled` audit event must commit or roll back TOGETHER, inside one
 * `SELECT ... FOR UPDATE`-guarded transaction — so a request can never observe/report
 * success ("200 mfaEnrolled: true") unless BOTH are durably committed. The concurrency test
 * below drives that directly against real Postgres row locking (not a mock), which is the
 * only way to actually prove the serialization holds.
 */

const SUITE_EMAIL_PREFIX = 't035-mfa';

function suiteEmail(slug: string): string {
  return `${SUITE_EMAIL_PREFIX}-${slug}-${randomUUID()}@example.com`;
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
     VALUES ($1, $2, 't035 test toggle')
     ON CONFLICT ("feature_key") DO UPDATE SET "enabled" = EXCLUDED."enabled"`,
    [ACCOUNTS_FEATURE_KEY, enabled],
  );
}

describe('POST /accounts/mfa/enroll + /confirm (T035, HTTP integration)', () => {
  const issuer = 'http://127.0.0.1/realms/kemfai-customers-mfa-test';
  const audience = 'kemfai-api-mfa-test';
  let app: INestApplication;
  let keycloak: FakeKeycloak;
  let fakeKeycloakUsers: FakeKeycloakUsers;
  const createdAccountIds: string[] = [];
  let suiteCreatedFeatureRow = false;

  beforeAll(async () => {
    keycloak = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;

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
  });

  afterAll(async () => {
    if (createdAccountIds.length > 0) {
      const ids = createdAccountIds.splice(0, createdAccountIds.length);
      await controlDataSource.query('DELETE FROM "audit_event" WHERE "subject_id" = ANY($1)', [
        ids,
      ]);
      await controlDataSource.query('DELETE FROM "account" WHERE "id" = ANY($1)', [ids]);
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
    await keycloak.close();
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
    delete process.env.KEYCLOAK_ISSUER;
    delete process.env.KEYCLOAK_API_AUDIENCE;
    delete process.env.KEYCLOAK_JWKS_URI;
  });

  async function createAccount(overrides: Partial<Account> = {}): Promise<Account> {
    const keycloakUserId = randomUUID();
    const email = suiteEmail('acct');
    const accountRepo = controlDataSource.getRepository(Account);
    const account = await accountRepo.save(
      accountRepo.create({
        keycloakUserId,
        email,
        emailVerified: true,
        mfaEnrolled: false,
        ...overrides,
      }),
    );
    createdAccountIds.push(account.id);
    fakeKeycloakUsers.users.set(keycloakUserId, {
      id: keycloakUserId,
      email,
      emailVerified: true,
      requiredActions: [],
      hasOtpCredential: false,
    });
    return account;
  }

  async function tokenFor(account: Account): Promise<string> {
    return keycloak.signAccessToken({ sub: account.keycloakUserId });
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

  function enroll(token?: string) {
    const req = request(app.getHttpServer()).post('/accounts/mfa/enroll');
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  function confirm(token?: string) {
    const req = request(app.getHttpServer()).post('/accounts/mfa/confirm');
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  describe('authentication', () => {
    it('401 with no bearer token on either route', async () => {
      await enroll().expect(401);
      await confirm().expect(401);
    });
  });

  describe('verified-account precondition (Acceptance Scenario 1.4)', () => {
    it('unverified account → 403 on enroll AND confirm, zero Keycloak/state/audit side effects', async () => {
      const account = await createAccount({ emailVerified: false });
      const token = await tokenFor(account);

      await enroll(token).expect(403);
      await confirm(token).expect(403);

      expect((await accountRow(account.id))?.mfaEnrolled).toBe(false);
      expect(await auditActionsFor(account.id)).toEqual([]);
    });
  });

  describe('enroll (T035)', () => {
    it('adds CONFIGURE_TOTP to the Keycloak user', async () => {
      const account = await createAccount();
      const token = await tokenFor(account);

      const response = await enroll(token).expect(200);
      expect(response.body).toEqual({ accountId: account.id });
      expect(fakeKeycloakUsers.users.get(account.keycloakUserId)?.requiredActions).toContain(
        'CONFIGURE_TOTP',
      );
    });

    it('already enrolled: idempotent no-op, never calls Keycloak again', async () => {
      const account = await createAccount({ mfaEnrolled: true });
      const token = await tokenFor(account);
      fakeKeycloakUsers.failNextBeginTotpEnrollment = new Error('must not be called');

      await enroll(token).expect(200);
    });
  });

  describe('confirm before Keycloak TOTP setup is complete', () => {
    it('409, zero state change', async () => {
      const account = await createAccount();
      const token = await tokenFor(account);

      await confirm(token).expect(409);

      expect((await accountRow(account.id))?.mfaEnrolled).toBe(false);
      expect(await auditActionsFor(account.id)).toEqual([]);
    });
  });

  describe('confirm happy path (Acceptance Scenario 1.4)', () => {
    it('flips mfaEnrolled and emits exactly one account.mfa_enrolled audit event', async () => {
      const account = await createAccount();
      const token = await tokenFor(account);
      fakeKeycloakUsers.completeTotpSetup(account.keycloakUserId);

      const response = await confirm(token).expect(200);
      expect(response.body).toEqual({ accountId: account.id, mfaEnrolled: true });

      expect((await accountRow(account.id))?.mfaEnrolled).toBe(true);
      expect(await auditActionsFor(account.id)).toEqual(['account.mfa_enrolled']);
    });

    it('repeat confirm calls are idempotent — no second audit event', async () => {
      const account = await createAccount();
      const token = await tokenFor(account);
      fakeKeycloakUsers.completeTotpSetup(account.keycloakUserId);

      await confirm(token).expect(200);
      const second = await confirm(token).expect(200);
      expect(second.body).toEqual({ accountId: account.id, mfaEnrolled: true });

      expect(
        (await auditActionsFor(account.id)).filter((a) => a === 'account.mfa_enrolled'),
      ).toHaveLength(1);
    });
  });

  describe('failure atomicity (T032/T033 discipline applied to MFA confirmation)', () => {
    it('audit failure → 503 with the flag rolled back TOGETHER (same DB transaction); a retry then succeeds', async () => {
      const account = await createAccount();
      const token = await tokenFor(account);
      fakeKeycloakUsers.completeTotpSetup(account.keycloakUserId);

      const auditSpy = jest
        .spyOn(AuditService.prototype, 'recordAccountMfaEnrolled')
        .mockRejectedValueOnce(new Error('audit insert failed'));
      try {
        await confirm(token).expect(503);
      } finally {
        auditSpy.mockRestore();
      }

      // Rolled back TOGETHER: the flag flip was never left dangling without its audit event.
      expect((await accountRow(account.id))?.mfaEnrolled).toBe(false);
      expect(await auditActionsFor(account.id)).toEqual([]);

      await confirm(token).expect(200);
      expect(await auditActionsFor(account.id)).toEqual(['account.mfa_enrolled']);
    });
  });

  describe('concurrency (Constitution Principle VII + 2026-09-21 review finding)', () => {
    it('two concurrent confirms, no induced failure → BOTH answer 200, exactly one commit and one audit event', async () => {
      const account = await createAccount();
      const token = await tokenFor(account);
      fakeKeycloakUsers.completeTotpSetup(account.keycloakUserId);

      const [first, second] = await Promise.all([confirm(token), confirm(token)]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body).toEqual({ accountId: account.id, mfaEnrolled: true });
      expect(second.body).toEqual({ accountId: account.id, mfaEnrolled: true });

      expect((await accountRow(account.id))?.mfaEnrolled).toBe(true);
      expect(
        (await auditActionsFor(account.id)).filter((a) => a === 'account.mfa_enrolled'),
      ).toHaveLength(1);
    });

    it(
      'two concurrent confirms where the request that acquires the row lock FIRST has its audit fail → ' +
        'exactly one 200 and one 503 (never two 200s), and the durable state matches the 200 exactly',
      async () => {
        const account = await createAccount();
        const token = await tokenFor(account);
        fakeKeycloakUsers.completeTotpSetup(account.keycloakUserId);

        // mockRejectedValueOnce is consumed by whichever transaction reaches the audit
        // write first in real time. Because confirm() takes a `SELECT ... FOR UPDATE`
        // lock on the account row BEFORE flipping the flag or auditing, the second
        // request's transaction cannot even begin reading account state until the
        // first's commits or rolls back — so the audit call is inherently serialized:
        // whichever request wins the row-lock race is deterministically the one whose
        // audit call this spy intercepts, regardless of which HTTP request "started"
        // first from the test's point of view.
        const auditSpy = jest
          .spyOn(AuditService.prototype, 'recordAccountMfaEnrolled')
          .mockRejectedValueOnce(new Error('audit insert failed'));

        let statuses: number[];
        let winnerBody: unknown;
        try {
          const [first, second] = await Promise.all([confirm(token), confirm(token)]);
          statuses = [first.status, second.status].sort((a, b) => a - b);
          // The critical property under test: whichever response reports success, the
          // durable state backs it up EXACTLY — mfaEnrolled=true with its audit event
          // committed. No response ever reports 200 while that pair is only partially
          // true (the original review finding this test targets).
          winnerBody = (first.status === 200 ? first : second).body;
        } finally {
          auditSpy.mockRestore();
        }

        expect(statuses).toEqual([200, 503]);
        expect(winnerBody).toEqual({ accountId: account.id, mfaEnrolled: true });

        expect((await accountRow(account.id))?.mfaEnrolled).toBe(true);
        expect(
          (await auditActionsFor(account.id)).filter((a) => a === 'account.mfa_enrolled'),
        ).toHaveLength(1);
      },
    );
  });

  describe('feature-flag gate (Constitution Principle VI)', () => {
    it('hides enroll and confirm with 404 while module.accounts is disabled', async () => {
      const account = await createAccount();
      const token = await tokenFor(account);
      fakeKeycloakUsers.completeTotpSetup(account.keycloakUserId);

      await setAccountsFlag(false);
      try {
        await enroll(token).expect(404);
        await confirm(token).expect(404);
        expect((await accountRow(account.id))?.mfaEnrolled).toBe(false);
      } finally {
        await setAccountsFlag(true);
      }
    });
  });
});
