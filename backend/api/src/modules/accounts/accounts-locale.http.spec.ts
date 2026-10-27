import { Module, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { type KeyObject, generateKeyPairSync } from 'node:crypto';
import * as http from 'node:http';
import * as request from 'supertest';
import { exportJWK, SignJWT } from 'jose';

import { AppModule } from '../../app.module';
import { QueuesModule } from '../../common/queues/queues.module';
import { ALL_QUEUE_NAMES } from '../../common/queues/queue-names';
import controlDataSource from '../../database/data-source';
import { Account } from './entities/account.entity';

/**
 * Stands in for QueuesModule in this HTTP fixture: provides an inert object (no Redis
 * connection, no onModuleInit, no worker/scheduler lifecycle) under every queue token so
 * AccountsService/TenantsService/global providers that @InjectQueue(...) resolve cleanly,
 * without booting BullMQ's live Redis-backed infrastructure (QueueSchedulingService,
 * TrialExpirySweepProcessor, …) that this locale-only suite never exercises.
 */
const inertQueue = { add: async () => undefined } as const;
@Module({
  providers: ALL_QUEUE_NAMES.map((name) => ({
    provide: getQueueToken(name),
    useValue: inertQueue,
  })),
  exports: ALL_QUEUE_NAMES.map((name) => getQueueToken(name)),
})
class IsolatedQueuesModule {}

/**
 * T104 — HTTP-level integration proof of PATCH/GET /accounts/me/locale through the REAL
 * Nest pipeline: global BearerAuthGuard (RS256 verification against a per-test JWKS
 * server), global ValidationPipe (422 contract), controller → service → repository.
 * The repository layer alone is stubbed (controlDataSource.getRepository), matching the
 * codebase's established integration-test doctrine for DB isolation.
 */

let app: INestApplication;
let jwksServer: http.Server;
const keycloakSub = 'locale-e2e-sub';
const accountsById = new Map<string, Partial<Account>>();

async function mintToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const { privateKey } = (globalThis as unknown as { __e2eKeys: { privateKey: KeyObject } })
    .__e2eKeys;
  return new SignJWT({ realm_access: { roles: [] }, ...overrides })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(process.env.KEYCLOAK_ISSUER!)
    .setAudience('kemfai-api')
    .setSubject(keycloakSub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

beforeAll(async () => {
  // 1) per-test RSA keypair + JWKS HTTP server
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  (globalThis as any).__e2eKeys = { privateKey };
  const jwk = await exportJWK(publicKey);
  jwksServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', r));
  const port = (jwksServer.address() as { port: number }).port;

  process.env.KEYCLOAK_ISSUER = 'http://127.0.0.1:1/realms/kemfai-customers';
  process.env.KEYCLOAK_JWKS_URI = `http://127.0.0.1:${port}/certs`;
  process.env.KEYCLOAK_API_AUDIENCE = 'kemfai-api';

  // 2) real Nest app with the REAL global guards/pipes
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideModule(QueuesModule)
    .useModule(IsolatedQueuesModule)
    .compile();
  app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  // 3) repository stubs (DB isolation per doctrine) — Account persistence under test;
  //    Tenant/AuditEvent backs the global TenantScopeGuard so it resolves cleanly.
  jest.spyOn(controlDataSource, 'transaction').mockImplementation(async (cb: any) =>
    cb({
      getRepository: (t: any) =>
        jest.spyOn(controlDataSource, 'getRepository').mock.calls
          ? (controlDataSource.getRepository as any)(t)
          : {},
    }),
  );
  jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: any) => {
    const name = typeof target === 'function' ? target.name : String(target);
    if (name === 'Account') {
      return {
        findOne: async ({ where }: any) =>
          [...accountsById.values()].find((a) => a.keycloakUserId === where.keycloakUserId) ?? null,
        save: async (a: any) => {
          accountsById.set(a.id ?? 'a1', a);
          return a;
        },
      } as any;
    }
    if (name === 'Tenant') {
      return {
        findOne: async () => null,
        createQueryBuilder: () => ({
          select: () => ({ setParameter: () => ({ getRawOne: async () => ({ exists: '0' }) }) }),
        }),
      } as any;
    }
    if (name === 'AuditEvent') {
      return {
        insert: async () => undefined, // append-only audit writer uses insert (T014/T019)
      } as any;
    }
    if (name === 'FeatureFlag') {
      return {
        // AccountsController is class-gated by module.accounts. Keep this T104 fixture's
        // prerequisite explicit now that a missing required row correctly fails closed.
        findOne: async ({ where }: any) =>
          where.featureKey === 'module.accounts'
            ? { featureKey: 'module.accounts', enabled: true }
            : null,
      } as any;
    }
    // Generic fallback for every other repository the global guards/interceptors consult:
    // absent rows, no behavior change.
    return {
      findOne: async () => null,
      find: async () => [],
      save: async (e: any) => e,
      create: (e: any) => e,
      insert: async () => undefined,
    } as any;
  });
});

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  jest.restoreAllMocks();
});

describe('PATCH/GET /accounts/me/locale (T104, HTTP integration)', () => {
  beforeEach(() => {
    accountsById.clear();
    accountsById.set('a1', { id: 'a1', keycloakUserId: keycloakSub, preferredLocale: null });
  });

  it('401 without a bearer token', async () => {
    await request(app.getHttpServer())
      .patch('/accounts/me/locale')
      .send({ locale: 'ar' })
      .expect(401);
  });

  it('401 with a forged (unsigned-against-JWKS) token', async () => {
    const garbage = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.zzz';
    await request(app.getHttpServer())
      .patch('/accounts/me/locale')
      .set('authorization', `Bearer ${garbage}`)
      .send({ locale: 'ar' })
      .expect(401);
  });

  it('422 for a locale outside the contract enum', async () => {
    const token = await mintToken();
    await request(app.getHttpServer())
      .patch('/accounts/me/locale')
      .set('authorization', `Bearer ${token}`)
      .send({ locale: 'fr' })
      .expect(422);
  });

  it('PATCH persists then GET reads back the SAME account-scoped value (200s)', async () => {
    const token = await mintToken();
    await request(app.getHttpServer())
      .patch('/accounts/me/locale')
      .set('authorization', `Bearer ${token}`)
      .send({ locale: 'ar' })
      .expect(200);

    expect(accountsById.get('a1')?.preferredLocale).toBe('ar');

    const read = await request(app.getHttpServer())
      .get('/accounts/me/locale')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(read.body).toEqual({ locale: 'ar' });
  });

  it('GET returns null before any choice was made', async () => {
    const token = await mintToken();
    const read = await request(app.getHttpServer())
      .get('/accounts/me/locale')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(read.body).toEqual({ locale: null });
  });
});
