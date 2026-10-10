import { Module, type INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request = require('supertest');

import { AppModule } from '../../app.module';
import { ALL_QUEUE_NAMES } from '../../common/queues/queue-names';
import { QueuesModule } from '../../common/queues/queues.module';
import controlDataSource from '../../database/data-source';
import { Account, Locale } from '../accounts/entities/account.entity';
import { Plan } from '../entitlements/entities/plan.entity';
import { Tenant, TenantStatus } from '../tenants/entities/tenant.entity';
import { SubscriptionBillingCycle, SubscriptionStatus } from './entities/subscription.entity';
import { startFakeKeycloak, type FakeKeycloak } from '../../../test/support/fake-keycloak';

const ISSUER = 'http://127.0.0.1/realms/kemfai-customers-t061';
const AUDIENCE = 'kemfai-api-t061';
const SUBJECT_ID = '06100000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '06100000-0000-4000-8000-000000000002';
const TENANT_ID = '06100000-0000-4000-8000-000000000003';
const PLAN_ID = '06100000-0000-4000-8000-000000000004';
const SUBSCRIPTION_ID = '06100000-0000-4000-8000-000000000005';

const inertQueue = { add: async () => undefined } as const;

@Module({
  providers: ALL_QUEUE_NAMES.map((name) => ({
    provide: getQueueToken(name),
    useValue: inertQueue,
  })),
  exports: ALL_QUEUE_NAMES.map((name) => getQueueToken(name)),
})
class IsolatedQueuesModule {}

describe('T061 deployment configuration contract', () => {
  const repositoryRoot = resolve(__dirname, '../../../../..');
  const environmentExamplePath = resolve(repositoryRoot, 'infra/.env.example');
  const composePath = resolve(repositoryRoot, 'infra/docker/docker-compose.yml');
  const englishPlaceholder = 'OWNER_PROVIDED_EN_BANK_TRANSFER_INSTRUCTIONS';
  const arabicPlaceholder = 'OWNER_PROVIDED_AR_BANK_TRANSFER_INSTRUCTIONS';

  it('documents independent non-sensitive placeholders for owner-provided EN and AR instructions', () => {
    const environmentExample = readFileSync(environmentExamplePath, 'utf8');

    expect(environmentExample).toContain(
      `KEMFAI_BANK_TRANSFER_INSTRUCTIONS_EN=${englishPlaceholder}`,
    );
    expect(environmentExample).toContain(
      `KEMFAI_BANK_TRANSFER_INSTRUCTIONS_AR=${arabicPlaceholder}`,
    );
  });

  it('wires independent owner-provided EN and AR instructions into the composed API service', () => {
    const composedJson = execFileSync(
      'docker',
      ['compose', '-f', composePath, 'config', '--format', 'json'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          KEMFAI_ODOO_MASTER_PASSWORD: 'T061_NON_SECRET_ODOO_PLACEHOLDER',
          KEMFAI_TENANT_ADMIN_LOGIN: 'T061_NON_SECRET_LOGIN_PLACEHOLDER',
          KEMFAI_TENANT_ADMIN_PASSWORD: 'T061_NON_SECRET_PASSWORD_PLACEHOLDER',
          KEMFAI_BANK_TRANSFER_INSTRUCTIONS_EN: englishPlaceholder,
          KEMFAI_BANK_TRANSFER_INSTRUCTIONS_AR: arabicPlaceholder,
        },
      },
    );
    const composed = JSON.parse(composedJson) as {
      services: { api: { environment: Record<string, string> } };
    };

    expect(composed.services.api.environment.KEMFAI_BANK_TRANSFER_INSTRUCTIONS_EN).toBe(
      englishPlaceholder,
    );
    expect(composed.services.api.environment.KEMFAI_BANK_TRANSFER_INSTRUCTIONS_AR).toBe(
      arabicPlaceholder,
    );
  });
});

/**
 * T061 HTTP acceptance proof. Requests cross the real Nest adapter, production AppModule,
 * bearer-signature verification, global tenant/role guards, controller, service, and response
 * serialization. Only persistence is replaced with label-owned in-memory fixtures; this suite
 * never connects to a production/dev database or starts Redis/Odoo/MinIO.
 */
describe('GET /billing/subscription (T061)', () => {
  let app: INestApplication;
  let keycloak: FakeKeycloak;
  let ownerToken: string;
  const originalEnvironment = {
    issuer: process.env.KEYCLOAK_ISSUER,
    audience: process.env.KEYCLOAK_API_AUDIENCE,
    jwksUri: process.env.KEYCLOAK_JWKS_URI,
    instructionsEn: process.env.KEMFAI_BANK_TRANSFER_INSTRUCTIONS_EN,
    instructionsAr: process.env.KEMFAI_BANK_TRANSFER_INSTRUCTIONS_AR,
  };

  const account = {
    id: ACCOUNT_ID,
    keycloakUserId: SUBJECT_ID,
    preferredLocale: Locale.EN,
  } as Account;
  const tenant = {
    id: TENANT_ID,
    accountId: ACCOUNT_ID,
    status: TenantStatus.READY,
  } as Tenant;
  const plan = {
    id: PLAN_ID,
    monthlyPrice: '1250.50',
    annualPrice: '12500.00',
    currency: 'AED',
  } as Plan;
  const subscription = {
    id: SUBSCRIPTION_ID,
    tenantId: TENANT_ID,
    planId: PLAN_ID,
    billingCycle: SubscriptionBillingCycle.MONTHLY,
    status: SubscriptionStatus.PENDING_ACTIVATION,
    currentPeriodStart: '2026-10-01',
    currentPeriodEnd: '2026-10-31',
  };

  beforeAll(async () => {
    keycloak = await startFakeKeycloak({ issuer: ISSUER, audience: AUDIENCE });
    process.env.KEYCLOAK_ISSUER = ISSUER;
    process.env.KEYCLOAK_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;
    process.env.KEMFAI_BANK_TRANSFER_INSTRUCTIONS_EN =
      'Transfer to the T061 disposable private-fixture account.';
    process.env.KEMFAI_BANK_TRANSFER_INSTRUCTIONS_AR = 'حوّل المبلغ إلى حساب T061 التجريبي الخاص.';

    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: unknown) => {
      if (target === Account) {
        return {
          findOne: jest.fn().mockResolvedValue(account),
          findOneBy: jest.fn().mockResolvedValue(account),
        } as never;
      }
      if (target === Tenant) {
        return {
          findOne: jest.fn().mockResolvedValue(tenant),
          findOneBy: jest.fn().mockResolvedValue(tenant),
        } as never;
      }
      if ((target as { name?: string }).name === 'Subscription') {
        return {
          findOne: jest.fn().mockResolvedValue(subscription),
          findOneBy: jest.fn().mockResolvedValue(subscription),
        } as never;
      }
      if (target === Plan) {
        return {
          findOne: jest.fn().mockResolvedValue(plan),
          findOneBy: jest.fn().mockResolvedValue(plan),
        } as never;
      }
      return {
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
        findOneBy: jest.fn().mockResolvedValue(null),
        insert: jest.fn().mockResolvedValue(undefined),
      } as never;
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideModule(QueuesModule)
      .useModule(IsolatedQueuesModule)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    ownerToken = await keycloak.signAccessToken({
      sub: SUBJECT_ID,
      roles: ['WorkspaceOwner'],
      tenantId: TENANT_ID,
    });
  });

  afterAll(async () => {
    await app?.close();
    await keycloak?.close();
    jest.restoreAllMocks();
    restoreEnvironment('KEYCLOAK_ISSUER', originalEnvironment.issuer);
    restoreEnvironment('KEYCLOAK_API_AUDIENCE', originalEnvironment.audience);
    restoreEnvironment('KEYCLOAK_JWKS_URI', originalEnvironment.jwksUri);
    restoreEnvironment('KEMFAI_BANK_TRANSFER_INSTRUCTIONS_EN', originalEnvironment.instructionsEn);
    restoreEnvironment('KEMFAI_BANK_TRANSFER_INSTRUCTIONS_AR', originalEnvironment.instructionsAr);
  });

  beforeEach(() => {
    account.preferredLocale = Locale.EN;
    subscription.billingCycle = SubscriptionBillingCycle.MONTHLY;
  });

  it('returns configured English instructions, cycle price, currency, period, and a tenant/subscription reference', async () => {
    const response = await request(app.getHttpServer())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(response.body).toEqual({
      status: 'PendingActivation',
      billingPeriodStart: '2026-10-01',
      billingPeriodEnd: '2026-10-31',
      amountDue: 1250.5,
      currency: 'AED',
      bankInstructions: 'Transfer to the T061 disposable private-fixture account.',
      paymentReference: `KEMFAI-${TENANT_ID}-${SUBSCRIPTION_ID}-2026-10-01`,
    });
  });

  it('uses persisted Arabic locale instructions and the annual cycle price without leaking English instructions', async () => {
    account.preferredLocale = Locale.AR;
    subscription.billingCycle = SubscriptionBillingCycle.ANNUAL;

    const response = await request(app.getHttpServer())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(response.body.amountDue).toBe(12500);
    expect(response.body.currency).toBe('AED');
    expect(response.body.bankInstructions).toBe('حوّل المبلغ إلى حساب T061 التجريبي الخاص.');
    expect(response.body.bankInstructions).not.toContain(
      'Transfer to the T061 disposable private-fixture account.',
    );
  });

  it('denies an authenticated customer who is not the Workspace Owner', async () => {
    const nonOwnerToken = await keycloak.signAccessToken({
      sub: SUBJECT_ID,
      roles: [],
      tenantId: TENANT_ID,
    });

    await request(app.getHttpServer())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${nonOwnerToken}`)
      .expect(403);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
