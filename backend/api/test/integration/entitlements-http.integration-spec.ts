import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

/**
 * T010 acceptance test for the actual HTTP contract: `GET /entitlements/me` behind
 * BearerAuthGuard, end to end (real Nest app, real Postgres, real JWKS fetch over HTTP).
 * Requires a reachable, already-migrated Postgres configured via CONTROL_DB_* env vars.
 */
describe('GET /entitlements/me (T010, HTTP)', () => {
  const issuer = 'http://127.0.0.1/realms/kemfai-customers-http-test';
  const audience = 'kemfai-api-http-test';
  let keycloak: FakeKeycloak;
  let app: INestApplication;

  beforeAll(async () => {
    keycloak = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;

    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await controlDataSource.query('DELETE FROM "account"');
    await controlDataSource.query('DELETE FROM "plan"');
  });

  afterAll(async () => {
    await app.close();
    await keycloak.close();
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
    delete process.env.KEYCLOAK_ISSUER;
    delete process.env.KEYCLOAK_API_AUDIENCE;
    delete process.env.KEYCLOAK_JWKS_URI;
  });

  async function createAccountWithPlan(keycloakUserId: string, email: string) {
    const planRepo = controlDataSource.getRepository(Plan);
    const plan = await planRepo.save(
      planRepo.create({
        name: `plan-for-${keycloakUserId}`,
        published: true,
        monthlyPrice: '10.00',
        annualPrice: '100.00',
        currency: 'USD',
      }),
    );
    const accountRepo = controlDataSource.getRepository(Account);
    await accountRepo.save(
      accountRepo.create({
        keycloakUserId,
        email,
        emailVerified: true,
        mfaEnrolled: true,
        selectedPlanId: plan.id,
      }),
    );
    return plan;
  }

  it('returns 401 with no Authorization header', async () => {
    await request(app.getHttpServer()).get('/entitlements/me').expect(401);
  });

  it('returns 401 for a validly signed token with the wrong issuer', async () => {
    const token = await keycloak.signAccessToken({
      sub: 'irrelevant',
      issuer: 'http://attacker.example.com/realms/other',
    });
    await request(app.getHttpServer())
      .get('/entitlements/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('returns 401 for a validly signed token with the wrong audience', async () => {
    const token = await keycloak.signAccessToken({
      sub: 'irrelevant',
      audience: 'some-other-client',
    });
    await request(app.getHttpServer())
      .get('/entitlements/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it("returns the authenticated account's own plan entitlements, resolved server-side from the JWT sub", async () => {
    const plan = await createAccountWithPlan(
      '11111111-1111-4111-8111-111111111111',
      'http-a@example.com',
    );
    const token = await keycloak.signAccessToken({ sub: '11111111-1111-4111-8111-111111111111' });

    const response = await request(app.getHttpServer())
      .get('/entitlements/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.planId).toBe(plan.id);
    expect(response.body.trialWindowDays).toBe(14);
    expect(response.body.autoRestrictUnpaid).toBe(true);
  });

  it("does not leak another account's plan: two tokens for two accounts each get only their own plan", async () => {
    const planA = await createAccountWithPlan(
      '22222222-2222-4222-8222-222222222222',
      'http-x@example.com',
    );
    const planB = await createAccountWithPlan(
      '33333333-3333-4333-8333-333333333333',
      'http-y@example.com',
    );
    const tokenA = await keycloak.signAccessToken({ sub: '22222222-2222-4222-8222-222222222222' });
    const tokenB = await keycloak.signAccessToken({ sub: '33333333-3333-4333-8333-333333333333' });

    const responseA = await request(app.getHttpServer())
      .get('/entitlements/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const responseB = await request(app.getHttpServer())
      .get('/entitlements/me')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);

    expect(responseA.body.planId).toBe(planA.id);
    expect(responseB.body.planId).toBe(planB.id);
    expect(responseA.body.planId).not.toBe(responseB.body.planId);
  });

  it('returns 401 for a token whose subject has no linked account', async () => {
    const token = await keycloak.signAccessToken({ sub: '55555555-5555-4555-8555-555555555555' });
    await request(app.getHttpServer())
      .get('/entitlements/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('returns 404 for a token whose account has not selected a plan yet', async () => {
    const accountRepo = controlDataSource.getRepository(Account);
    await accountRepo.save(
      accountRepo.create({
        keycloakUserId: '44444444-4444-4444-8444-444444444444',
        email: 'http-no-plan@example.com',
        emailVerified: true,
        mfaEnrolled: false,
        selectedPlanId: null,
      }),
    );
    const token = await keycloak.signAccessToken({ sub: '44444444-4444-4444-8444-444444444444' });

    await request(app.getHttpServer())
      .get('/entitlements/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
