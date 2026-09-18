import { Body, Controller, INestApplication, Module, Post, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { AuthenticatedRequest } from '../../src/common/guards/bearer-auth.guard';
import { Public } from '../../src/common/decorators/public.decorator';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

/**
 * T020 acceptance test, end to end against the REAL guard/interceptor chain registered in
 * AppModule (BearerAuthGuard + TenantScopeGuard + RoleGuard + IdempotencyKeyInterceptor,
 * all via APP_GUARD/APP_INTERCEPTOR) — not a standalone instance of the interceptor. This
 * is what proves the interceptor actually guards live mutating endpoints rather than only
 * a hand-wired unit test double (a gap an earlier rejected draft left open).
 *
 * `counter` increments once per genuine handler execution; assertions asking about
 * `callNumber` are really asking "did the side effect happen more than once", which is the
 * T020 acceptance criterion itself, not just "did the HTTP response look right".
 *
 * Coverage deliberately includes the cases earlier review rejections called out:
 * - unauthenticated callers sharing an IP/key never receive each other's responses
 *   (nothing is stored or replayed for them at all);
 * - the claim row is committed BEFORE the handler runs (`claim-check` reads its own row
 *   from inside the handler and must observe it `pending`);
 * - no connection is held while the handler executes (`db-work` handlers check out real
 *   control-DB connections; far more concurrent keyed requests than the pool size must
 *   still all complete — a claim-held-connection design deadlocks here).
 */
@Controller('test-idempotency')
class ProbeController {
  private counter = 0;

  @Public()
  @Post('reset')
  reset(): { ok: true } {
    this.counter = 0;
    return { ok: true };
  }

  @Public()
  @Post('public')
  publicEndpoint(@Body() body: { email: string }): { callNumber: number; email: string } {
    this.counter += 1;
    return { callNumber: this.counter, email: body.email };
  }

  @Post('authenticated')
  authenticatedEndpoint(@Req() req: AuthenticatedRequest): {
    callNumber: number;
    keycloakUserId: string;
  } {
    this.counter += 1;
    return { callNumber: this.counter, keycloakUserId: req.auth.keycloakUserId };
  }

  /**
   * Handler that inspects the idempotency_key table for its own claim while it is running.
   * If the interceptor truly claims before executing the handler (and only completes the
   * row afterwards), this MUST report status 'pending' — proving a persisted claim always
   * predates the side effect it guards.
   */
  @Post('claim-check')
  async claimCheck(
    @Req() req: AuthenticatedRequest & { headers: Record<string, unknown> },
  ): Promise<{
    callNumber: number;
    claimStatusSeenByHandler: string | null;
  }> {
    const key = req.headers['idempotency-key'];
    const rows = (await controlDataSource.query(
      `SELECT "status" FROM "idempotency_key" WHERE "idempotency_key" = $1 AND "method" = 'POST'`,
      [key as string],
    )) as Array<{ status: string }>;
    this.counter += 1;
    return { callNumber: this.counter, claimStatusSeenByHandler: rows[0]?.status ?? null };
  }

  /**
   * Handler that itself consumes a control-DB connection for a while — the stand-in for any
   * real mutating handler doing database work. Firing more of these concurrently than the
   * pool can serve would deadlock the whole app if the interceptor held a claim connection
   * (or transaction) open across handler execution.
   */
  @Post('db-work')
  async dbWork(): Promise<{ callNumber: number }> {
    const callNumber = ++this.counter; // captured before the await: each handler reports its own execution
    await controlDataSource.query('SELECT pg_sleep(0.15)');
    return { callNumber };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('IdempotencyKeyInterceptor (T020, integration)', () => {
  const issuer = 'http://127.0.0.1/realms/kemfai-idempotency-test';
  const audience = 'kemfai-api-idempotency-test';
  let keycloak: FakeKeycloak;
  let app: INestApplication;
  let tokenUserA: string;
  let tokenUserB: string;
  const userAId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  beforeAll(async () => {
    keycloak = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;

    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, ProbeModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    tokenUserA = await keycloak.signAccessToken({ sub: userAId });
    tokenUserB = await keycloak.signAccessToken({ sub: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  });

  beforeEach(async () => {
    await controlDataSource.query('DELETE FROM "idempotency_key"');
    await request(app.getHttpServer()).post('/test-idempotency/reset');
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

  it('runs the handler on the first authenticated request and never again on replay with the same key and body', async () => {
    const first = await request(app.getHttpServer())
      .post('/test-idempotency/authenticated')
      .set('Authorization', `Bearer ${tokenUserA}`)
      .set('Idempotency-Key', 'key-replay')
      .send({ email: 'replay@example.com' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ callNumber: 1, keycloakUserId: userAId });

    const second = await request(app.getHttpServer())
      .post('/test-idempotency/authenticated')
      .set('Authorization', `Bearer ${tokenUserA}`)
      .set('Idempotency-Key', 'key-replay')
      .send({ email: 'replay@example.com' });

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);

    const counterCheck = await request(app.getHttpServer())
      .post('/test-idempotency/authenticated')
      .set('Authorization', `Bearer ${tokenUserA}`)
      .send({ email: 'no-key-so-runs-for-real@example.com' });
    expect(counterCheck.body.callNumber).toBe(2);
  });

  it('does not intercept requests with no Idempotency-Key header — each one genuinely re-executes', async () => {
    const first = await request(app.getHttpServer())
      .post('/test-idempotency/authenticated')
      .set('Authorization', `Bearer ${tokenUserA}`)
      .send({});
    const second = await request(app.getHttpServer())
      .post('/test-idempotency/authenticated')
      .set('Authorization', `Bearer ${tokenUserA}`)
      .send({});

    expect(first.body.callNumber).toBe(1);
    expect(second.body.callNumber).toBe(2);
  });

  it('rejects reuse of the same Idempotency-Key with a different payload (409) and does not re-run the handler', async () => {
    const first = await request(app.getHttpServer())
      .post('/test-idempotency/authenticated')
      .set('Authorization', `Bearer ${tokenUserA}`)
      .set('Idempotency-Key', 'key-conflict')
      .send({ email: 'first@example.com' });
    expect(first.body.callNumber).toBe(1);

    const conflicting = await request(app.getHttpServer())
      .post('/test-idempotency/authenticated')
      .set('Authorization', `Bearer ${tokenUserA}`)
      .set('Idempotency-Key', 'key-conflict')
      .send({ email: 'different@example.com' });

    expect(conflicting.status).toBe(409);

    const followUp = await request(app.getHttpServer())
      .post('/test-idempotency/authenticated')
      .set('Authorization', `Bearer ${tokenUserA}`)
      .send({ email: 'probe@example.com' });
    expect(followUp.body.callNumber).toBe(2);
  });

  it('scopes claims by authenticated caller: two different actors reusing the same key both execute (no cross-actor collision)', async () => {
    const fromA = await request(app.getHttpServer())
      .post('/test-idempotency/authenticated')
      .set('Authorization', `Bearer ${tokenUserA}`)
      .set('Idempotency-Key', 'shared-key')
      .send({});
    const fromB = await request(app.getHttpServer())
      .post('/test-idempotency/authenticated')
      .set('Authorization', `Bearer ${tokenUserB}`)
      .set('Idempotency-Key', 'shared-key')
      .send({});

    expect(fromA.body.callNumber).toBe(1);
    expect(fromB.body.callNumber).toBe(2);
    expect(fromA.body.keycloakUserId).not.toBe(fromB.body.keycloakUserId);

    // Each actor still replays against their own claim.
    const replayA = await request(app.getHttpServer())
      .post('/test-idempotency/authenticated')
      .set('Authorization', `Bearer ${tokenUserA}`)
      .set('Idempotency-Key', 'shared-key')
      .send({});
    expect(replayA.body).toEqual(fromA.body);
  });

  it('stores nothing for unauthenticated callers and never replays to them: same IP, same key, same body — every request executes its own side effect', async () => {
    // Two anonymous callers (test server = one shared source IP, the exact shared-NAT shape
    // review flagged): with no server-verified identity there must be no stored response
    // that the second caller could be served, or the first caller's response leaked.
    const first = await request(app.getHttpServer())
      .post('/test-idempotency/public')
      .set('Idempotency-Key', 'anon-shared')
      .send({ email: 'anon@example.com' });
    const second = await request(app.getHttpServer())
      .post('/test-idempotency/public')
      .set('Idempotency-Key', 'anon-shared')
      .send({ email: 'anon@example.com' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.callNumber).toBe(1);
    expect(second.body.callNumber).toBe(2);

    const rows = await controlDataSource.query(
      `SELECT * FROM "idempotency_key" WHERE "idempotency_key" = $1`,
      ['anon-shared'],
    );
    expect(rows).toHaveLength(0);
  });

  it('commits the claim before the handler runs: the handler observes its own row as pending, and completed only afterwards', async () => {
    const response = await request(app.getHttpServer())
      .post('/test-idempotency/claim-check')
      .set('Authorization', `Bearer ${tokenUserA}`)
      .set('Idempotency-Key', 'key-claim-check')
      .send({ email: 'claim@example.com' });

    expect(response.status).toBe(201);
    expect(response.body.claimStatusSeenByHandler).toBe('pending');

    const rows = await controlDataSource.query(
      `SELECT "status" FROM "idempotency_key" WHERE "idempotency_key" = $1`,
      ['key-claim-check'],
    );
    expect(rows[0].status).toBe('completed');
  });

  it('never runs the handler twice for two concurrent requests racing on the same key', async () => {
    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post('/test-idempotency/authenticated')
        .set('Authorization', `Bearer ${tokenUserA}`)
        .set('Idempotency-Key', 'key-race')
        .send({ email: 'race@example.com' }),
      request(app.getHttpServer())
        .post('/test-idempotency/authenticated')
        .set('Authorization', `Bearer ${tokenUserA}`)
        .set('Idempotency-Key', 'key-race')
        .send({ email: 'race@example.com' }),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body).toEqual(second.body);
    expect(first.body.callNumber).toBe(1);

    const followUp = await request(app.getHttpServer())
      .post('/test-idempotency/authenticated')
      .set('Authorization', `Bearer ${tokenUserA}`)
      .send({ email: 'probe@example.com' });
    expect(followUp.body.callNumber).toBe(2);
  });

  it('completes far more concurrent keyed requests than the connection pool can hold when handlers themselves use control-DB connections', async () => {
    // node-postgres's default pool is 10 connections; 24 concurrent keyed requests whose
    // handlers each hold a connection for 150ms would deadlock forever if the interceptor
    // kept a claim connection/transaction open while its handler ran.
    const responses = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        request(app.getHttpServer())
          .post('/test-idempotency/db-work')
          .set('Authorization', `Bearer ${tokenUserA}`)
          .set('Idempotency-Key', `saturation-${i}`)
          .send({ n: i }),
      ),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    const callNumbers = responses.map((r) => r.body.callNumber).sort((a, b) => a - b);
    expect(callNumbers).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));

    const completed = await controlDataSource.query(
      `SELECT count(*)::int AS n FROM "idempotency_key" WHERE "status" = 'completed'`,
    );
    expect(completed[0].n).toBe(24);
  });

  it('replays a single execution to many concurrent same-key requests even when the handler does real database work', async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app.getHttpServer())
          .post('/test-idempotency/db-work')
          .set('Authorization', `Bearer ${tokenUserA}`)
          .set('Idempotency-Key', 'race-db')
          .send({ email: 'race@example.com' }),
      ),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(responses.every((r) => r.body.callNumber === 1)).toBe(true);
  });

  it("persists the claim with the caller's verified identity in scope, matching the (scope, key, method, path) it was called with", async () => {
    await request(app.getHttpServer())
      .post('/test-idempotency/authenticated')
      .set('Authorization', `Bearer ${tokenUserA}`)
      .set('Idempotency-Key', 'key-persisted')
      .send({ email: 'persisted@example.com' });

    const rows = await controlDataSource.query(
      `SELECT "scope", "idempotency_key", "method", "path", "status" FROM "idempotency_key" WHERE "idempotency_key" = $1`,
      ['key-persisted'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe(`keycloak:${userAId}`);
    expect(rows[0].method).toBe('POST');
    expect(rows[0].path).toBe('/test-idempotency/authenticated');
    expect(rows[0].status).toBe('completed');
  });
});
