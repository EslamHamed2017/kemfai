import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Job, Queue, Worker } from 'bullmq';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { FakeKeycloak, startFakeKeycloak } from './fake-keycloak';
import { QUEUE_TENANT_PROVISION } from '../../src/common/queues/queue-names';
import { redisConnectionFromUrl } from '../../src/common/queues/redis-connection';
import { OpenApiContractValidator, ContractCoverage } from './openapi-contract-validator';

export function tenantsHttpSuite(contract = false): void {
  describe(`tenant /me HTTP ${contract ? 'contract' : 'integration'} (T045)`, () => {
    let app: INestApplication;
    let keycloak: FakeKeycloak;
    let queue: Queue;
    const accounts: Account[] = [];
    const validator = contract ? new OpenApiContractValidator() : null;
    const coverage = validator ? new ContractCoverage(validator) : null;
    const issuer = 'http://127.0.0.1/realms/kemfai-customers-t045';
    const audience = 'kemfai-api-t045';
    const observe = (path: string, method: string, response: { status: number; body: unknown }) => {
      coverage?.record(path, method, response.status, response.body);
    };

    beforeAll(async () => {
      keycloak = await startFakeKeycloak({ issuer, audience });
      process.env.KEYCLOAK_ISSUER = issuer;
      process.env.KEYCLOAK_API_AUDIENCE = audience;
      process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;
      if (!controlDataSource.isInitialized) await controlDataSource.initialize();
      await controlDataSource.runMigrations();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      queue = app.get<Queue>(getQueueToken(QUEUE_TENANT_PROVISION));
    });
    afterAll(async () => {
      for (const account of accounts) {
        const job = await queue.getJob(account.id);
        if (job) await job.remove();
        await controlDataSource.query(
          'DELETE FROM audit_event WHERE tenant_id IN (SELECT id FROM tenant WHERE account_id = $1)',
          [account.id],
        );
        await controlDataSource.query('DELETE FROM tenant WHERE account_id = $1', [account.id]);
        await controlDataSource.query('DELETE FROM account WHERE id = $1', [account.id]);
      }
      await app.close();
      await keycloak.close();
      if (controlDataSource.isInitialized) await controlDataSource.destroy();
      delete process.env.KEYCLOAK_ISSUER;
      delete process.env.KEYCLOAK_API_AUDIENCE;
      delete process.env.KEYCLOAK_JWKS_URI;
      if (coverage) {
        coverage.assertFullCoverage('/tenants/me', 'get');
        coverage.assertFullCoverage('/tenants/me/provisioning-retry', 'post');
      }
    });
    async function account(verified = true) {
      const repo = controlDataSource.getRepository(Account);
      const row = await repo.save(
        repo.create({
          email: `t045-${randomUUID()}@example.com`,
          keycloakUserId: randomUUID(),
          emailVerified: verified,
        }),
      );
      accounts.push(row);
      return { row, token: await keycloak.signAccessToken({ sub: row.keycloakUserId }) };
    }
    async function tenant(accountId: string, status: TenantStatus) {
      const repo = controlDataSource.getRepository(Tenant);
      return repo.save(
        repo.create({
          accountId,
          status,
          failureReason: status === TenantStatus.FAILED ? 'Retry or contact support' : null,
        }),
      );
    }
    const get = (token?: string) => {
      const req = request(app.getHttpServer()).get('/tenants/me');
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };
    const retry = (token?: string) => {
      const req = request(app.getHttpServer()).post('/tenants/me/provisioning-retry');
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };
    it('requires a verified, known bearer account; never leaks another workspace', async () => {
      await get().expect(401);
      await retry().expect(401);
      const unverified = await account(false);
      observe('/tenants/me', 'get', await get(unverified.token).expect(403));
      observe('/tenants/me/provisioning-retry', 'post', await retry(unverified.token).expect(403));
      const unknownToken = await keycloak.signAccessToken({ sub: randomUUID() });
      observe('/tenants/me', 'get', await get(unknownToken).expect(404));
      observe('/tenants/me/provisioning-retry', 'post', await retry(unknownToken).expect(404));
      const a = await account();
      const b = await account();
      const first = await tenant(a.row.id, TenantStatus.READY);
      const second = await tenant(b.row.id, TenantStatus.FAILED);
      const response = await get(b.token).expect(200);
      observe('/tenants/me', 'get', response);
      expect(response.body).toEqual({
        tenantId: second.id,
        status: 'Failed',
        failureReason: 'Retry or contact support',
      });
      expect(JSON.stringify(response.body)).not.toContain(first.id);
      const denied = await retry(b.token).send({ tenantId: first.id }).expect(403);
      expect(denied.body.message).toContain('tenant scope violation');
    });
    it('polls Pending before row creation, then Creating and Ready without exposing database names', async () => {
      const a = await account();
      expect((await get(a.token).expect(200)).body).toEqual({
        tenantId: null,
        status: 'Pending',
        failureReason: null,
      });
      const row = await tenant(a.row.id, TenantStatus.CREATING);
      expect((await get(a.token).expect(200)).body).toEqual({
        tenantId: row.id,
        status: 'Creating',
        failureReason: null,
      });
      await controlDataSource.getRepository(Tenant).update(row.id, { status: TenantStatus.READY });
      expect((await get(a.token).expect(200)).body).toEqual({
        tenantId: row.id,
        status: 'Ready',
        failureReason: null,
      });
      const conflict = await retry(a.token).expect(409);
      observe('/tenants/me/provisioning-retry', 'post', conflict);
      expect(conflict.body).toEqual({ tenantId: row.id, status: 'Ready', failureReason: null });
      expect(await queue.getJob(a.row.id)).toBeUndefined();
      expect((await retry(a.token).expect(409)).body).toEqual(conflict.body);
    });
    it('rejects Creating without touching queue', async () => {
      const a = await account();
      await tenant(a.row.id, TenantStatus.CREATING);
      await retry(a.token).expect(409);
      expect(await queue.getJob(a.row.id)).toBeUndefined();
    });
    it('serializes simultaneous retries of a retained failed job and executes one new attempt', async () => {
      const a = await account();
      const row = await tenant(a.row.id, TenantStatus.FAILED);
      const worker = new Worker(
        QUEUE_TENANT_PROVISION,
        async () => {
          throw new Error('transient');
        },
        { connection: redisConnectionFromUrl() },
      );
      try {
        await new Promise<void>((resolve) => worker.once('ready', resolve));
        await queue.add('provision', { accountId: a.row.id }, { jobId: a.row.id });
        await new Promise<void>((resolve) => worker.once('failed', () => resolve()));
        for (
          let i = 0;
          i < 40 && (await (await queue.getJob(a.row.id))?.getState()) !== 'failed';
          i++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        await worker.close();
      }
      expect(await (await queue.getJob(a.row.id))?.getState()).toBe('failed');
      const results = await Promise.all([retry(a.token), retry(a.token)]);
      results.forEach((result) => {
        expect(result.status).toBe(202);
        observe('/tenants/me/provisioning-retry', 'post', result);
      });
      expect(results[0].body).toEqual({ tenantId: row.id, status: 'Pending', failureReason: null });
      expect((await queue.getJob(a.row.id))?.attemptsMade).toBe(1);
      expect((await queue.getJobs(['waiting'])).filter((job) => job.id === a.row.id)).toHaveLength(
        1,
      );
      expect(
        (await controlDataSource.getRepository(Tenant).findOneByOrFail({ id: row.id })).status,
      ).toBe(TenantStatus.PENDING);
      const attempts: string[] = [];
      const secondWorker = new Worker(
        QUEUE_TENANT_PROVISION,
        async (job) => {
          attempts.push(job.id!);
          return 'recovered';
        },
        { connection: redisConnectionFromUrl() },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          secondWorker.once('completed', () => resolve());
          secondWorker.once('error', reject);
        });
      } finally {
        await secondWorker.close();
      }
      expect(attempts).toEqual([a.row.id]);
      expect(await (await queue.getJob(a.row.id))?.getState()).toBe('completed');
      expect((await queue.getJobs(['waiting'])).filter((job) => job.id === a.row.id)).toHaveLength(
        0,
      );
    });
    it('atomically retries a retained completed job with the same ID', async () => {
      const a = await account();
      const row = await tenant(a.row.id, TenantStatus.FAILED);
      const worker = new Worker(QUEUE_TENANT_PROVISION, async () => 'first', {
        connection: redisConnectionFromUrl(),
      });
      try {
        await new Promise<void>((resolve) => worker.once('ready', resolve));
        await queue.add('provision', { accountId: a.row.id }, { jobId: a.row.id });
        await new Promise<void>((resolve, reject) => {
          worker.once('completed', () => resolve());
          worker.once('error', reject);
        });
      } finally {
        await worker.close();
      }
      expect(await (await queue.getJob(a.row.id))?.getState()).toBe('completed');
      await retry(a.token).expect(202);
      expect((await queue.getJob(a.row.id))?.id).toBe(a.row.id);
      expect((await queue.getJobs(['waiting'])).filter((job) => job.id === a.row.id)).toHaveLength(
        1,
      );
      expect((await get(a.token).expect(200)).body).toEqual({
        tenantId: row.id,
        status: 'Pending',
        failureReason: null,
      });
      // This test has no second worker; don't let its queued job leak into the next test.
      await (await queue.getJob(a.row.id))?.remove();
    });
    it('returns 409 without state change when a retained job is active', async () => {
      const a = await account();
      const row = await tenant(a.row.id, TenantStatus.FAILED);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const active = new Promise<void>((resolve) => {
        started = resolve;
      });
      const worker = new Worker(
        QUEUE_TENANT_PROVISION,
        async (job) => {
          if (job.id === a.row.id) {
            started();
            await held;
          }
        },
        { connection: redisConnectionFromUrl() },
      );
      try {
        await new Promise<void>((resolve) => worker.once('ready', resolve));
        await queue.add('provision', { accountId: a.row.id }, { jobId: a.row.id });
        await active;
        expect(await (await queue.getJob(a.row.id))?.getState()).toBe('active');
        const response = await retry(a.token).expect(409);
        observe('/tenants/me/provisioning-retry', 'post', response);
        expect(response.body).toEqual({
          tenantId: row.id,
          status: 'Failed',
          failureReason: 'Retry or contact support',
        });
        expect(await (await queue.getJob(a.row.id))?.getState()).toBe('active');
      } finally {
        release();
        await worker.close();
      }
      expect(
        (await controlDataSource.getRepository(Tenant).findOneByOrFail({ id: row.id })).status,
      ).toBe(TenantStatus.FAILED);
    });
    it('keeps Failed and retained job if atomic requeue fails', async () => {
      const a = await account();
      const row = await tenant(a.row.id, TenantStatus.FAILED);
      const worker = new Worker(
        QUEUE_TENANT_PROVISION,
        async () => {
          throw new Error('transient');
        },
        { connection: redisConnectionFromUrl() },
      );
      try {
        await new Promise<void>((resolve) => worker.once('ready', resolve));
        await queue.add('provision', { accountId: a.row.id }, { jobId: a.row.id });
        await new Promise<void>((resolve, reject) => {
          worker.once('failed', () => resolve());
          worker.once('error', reject);
        });
      } finally {
        await worker.close();
      }
      const job = await queue.getJob(a.row.id);
      expect(await job?.getState()).toBe('failed');
      const spy = jest
        .spyOn(Job.prototype, 'retry')
        .mockRejectedValueOnce(new Error('secret redis failure'));
      try {
        const response = await retry(a.token).expect(503);
        observe('/tenants/me/provisioning-retry', 'post', response);
        expect(JSON.stringify(response.body)).not.toContain('secret redis failure');
      } finally {
        spy.mockRestore();
      }
      expect(await job?.getState()).toBe('failed');
      expect((await get(a.token).expect(200)).body).toEqual({
        tenantId: row.id,
        status: 'Failed',
        failureReason: 'Retry or contact support',
      });
    });
    it('enqueues Pending recovery without a row and deduplicates the waiting job', async () => {
      const a = await account();
      const response = await retry(a.token).expect(202);
      expect(response.body).toEqual({ tenantId: null, status: 'Pending', failureReason: null });
      expect((await queue.getJob(a.row.id))?.data).toEqual({ accountId: a.row.id });
      await retry(a.token).expect(202);
      expect((await queue.getJobs(['waiting'])).filter((job) => job.id === a.row.id)).toHaveLength(
        1,
      );
    });
    it('queue failure returns 503 and keeps Failed state for a later retry', async () => {
      const a = await account();
      const row = await tenant(a.row.id, TenantStatus.FAILED);
      const spy = jest.spyOn(queue, 'add').mockRejectedValueOnce(new Error('secret queue detail'));
      const response = await retry(a.token).expect(503);
      observe('/tenants/me/provisioning-retry', 'post', response);
      expect(JSON.stringify(response.body)).not.toContain('secret queue detail');
      spy.mockRestore();
      expect((await get(a.token).expect(200)).body).toEqual({
        tenantId: row.id,
        status: 'Failed',
        failureReason: 'Retry or contact support',
      });
      await retry(a.token).expect(202);
    });
  });
}
