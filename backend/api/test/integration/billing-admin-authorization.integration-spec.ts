import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { load as loadYaml } from 'js-yaml';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { QUEUE_NOTIFICATION_BILLING_DECISION } from '../../src/common/queues/queue-names';
import { redisConnectionFromUrl } from '../../src/common/queues/redis-connection';
import { Account, BillingCycle } from '../../src/modules/accounts/entities/account.entity';
import {
  PaymentSubmission,
  PaymentSubmissionStatus,
} from '../../src/modules/billing-customer/entities/payment-submission.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import {
  SupportAccessGrant,
  SupportAccessGranteeRole,
} from '../../src/modules/support-access/entities/support-access-grant.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

const CUSTOMER_ISSUER = 'http://127.0.0.1/realms/kemfai-customers-t064';
const INTERNAL_ISSUER = 'http://127.0.0.1/realms/kemfai-internal-t064';
const AUDIENCE = 'kemfai-api-t064';

type CallShape = 'ui' | 'raw';
type SupportGrantState = 'none' | 'active' | 'expired' | 'revoked';
type ActorKey =
  | 'unauthenticated'
  | 'owner-own-tenant'
  | 'owner-foreign-tenant'
  | 'customer-forged-billing-admin'
  | 'billing-admin'
  | 'support-no-grant'
  | 'support-active-grant'
  | 'support-expired-grant'
  | 'support-revoked-grant';

interface ActorCase {
  key: ActorKey;
  expectedStatus: 200 | 401 | 403;
  supportGrant?: SupportGrantState;
}

interface EndpointCase {
  label: string;
  method: 'get' | 'post';
  contractPath: string;
  runtimePath(submissionId: string): string;
  body?: Record<string, string>;
}

const ENDPOINTS: readonly EndpointCase[] = [
  {
    label: 'review queue',
    method: 'get',
    contractPath: '/internal/billing/review-queue',
    runtimePath: () => '/internal/billing/review-queue',
  },
  {
    label: 'approve',
    method: 'post',
    contractPath: '/internal/billing/payment-submissions/{submissionId}/approve',
    runtimePath: (submissionId) => `/internal/billing/payment-submissions/${submissionId}/approve`,
  },
  {
    label: 'reject',
    method: 'post',
    contractPath: '/internal/billing/payment-submissions/{submissionId}/reject',
    runtimePath: (submissionId) => `/internal/billing/payment-submissions/${submissionId}/reject`,
    body: { reason: 'T064 private authorization fixture rejection' },
  },
  {
    label: 'request more information',
    method: 'post',
    contractPath: '/internal/billing/payment-submissions/{submissionId}/request-more-info',
    runtimePath: (submissionId) =>
      `/internal/billing/payment-submissions/${submissionId}/request-more-info`,
    body: { details: 'T064 private authorization fixture clarification' },
  },
];

const ACTORS: readonly ActorCase[] = [
  { key: 'unauthenticated', expectedStatus: 401 },
  // Internal billing routes trust only the internal issuer. Both owners therefore fail
  // authentication at the realm boundary rather than reaching role authorization.
  { key: 'owner-own-tenant', expectedStatus: 401 },
  { key: 'owner-foreign-tenant', expectedStatus: 401 },
  // A customer-realm token must remain powerless even if a BillingAdmin-looking claim is
  // injected into it. This is the behavioral proof that FR-004 is enforced by trust-domain
  // separation, not merely by today's Keycloak export/configuration.
  { key: 'customer-forged-billing-admin', expectedStatus: 401 },
  { key: 'billing-admin', expectedStatus: 200 },
  {
    key: 'support-no-grant',
    expectedStatus: 403,
    supportGrant: 'none',
  },
  {
    key: 'support-active-grant',
    expectedStatus: 403,
    supportGrant: 'active',
  },
  {
    key: 'support-expired-grant',
    expectedStatus: 403,
    supportGrant: 'expired',
  },
  {
    key: 'support-revoked-grant',
    expectedStatus: 403,
    supportGrant: 'revoked',
  },
];

/**
 * T064 test-first authorization specification.
 *
 * This suite boots the production AppModule and crosses the real Nest HTTP adapter plus the
 * global BearerAuthGuard -> TenantScopeGuard -> RoleGuard chain. It deliberately supplies no
 * probe controller and no mocked billing-admin route: T068-T070 own those endpoints. Until they
 * exist, Nest route lookup returns 404 before any route guard runs, so all 72 matrix rows are the
 * precise expected RED while the independent contract-enumeration assertion remains green.
 *
 * Both test identity domains use independent signing keys/JWKS endpoints and are configured at
 * the same time on one production AppModule. The ordinary KEYCLOAK_ISSUER/JWKS settings remain
 * customer-only; the separate KEYCLOAK_INTERNAL_* settings describe the internal trust domain
 * which /internal/billing/* must select structurally. A real customer billing route proves that
 * keeping both realms configured does not disable customer authentication. The local signing/
 * JWKS servers are explicit identity fixtures, not a claim of live external Keycloak coverage.
 * Every contracted /internal/billing/* endpoint is exercised through both the documented
 * UI-shaped request and a minimal raw replay. The expanded Support states match plan.md's
 * authorization strategy; none can turn a Support grant into BillingAdmin authority.
 */
describe('Billing Admin endpoint role matrix (T064)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let customerKeycloak: FakeKeycloak;
  let internalKeycloak: FakeKeycloak;
  let ownAccountId: string;
  let ownTenantId: string;
  let foreignAccountId: string;
  let foreignTenantId: string;
  let planId: string;
  let subscriptionId: string;
  let submissionId: string;
  const tokens = new Map<ActorKey, string>();
  const supportGrantIds = new Set<string>();
  const originalAuthEnvironment = {
    issuer: process.env.KEYCLOAK_ISSUER,
    audience: process.env.KEYCLOAK_API_AUDIENCE,
    jwksUri: process.env.KEYCLOAK_JWKS_URI,
    internalIssuer: process.env.KEYCLOAK_INTERNAL_ISSUER,
    internalAudience: process.env.KEYCLOAK_INTERNAL_API_AUDIENCE,
    internalJwksUri: process.env.KEYCLOAK_INTERNAL_JWKS_URI,
  };

  beforeAll(async () => {
    customerKeycloak = await startFakeKeycloak({ issuer: CUSTOMER_ISSUER, audience: AUDIENCE });
    internalKeycloak = await startFakeKeycloak({ issuer: INTERNAL_ISSUER, audience: AUDIENCE });
    configureBothAuthRealms();

    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const label = randomUUID();
    const planRepository = controlDataSource.getRepository(Plan);
    const plan = await planRepository.save(
      planRepository.create({
        name: `T064 private fixture ${label}`,
        published: false,
        monthlyPrice: '1250.50',
        annualPrice: '12505.00',
        currency: 'AED',
      }),
    );
    planId = plan.id;

    const accountRepository = controlDataSource.getRepository(Account);
    const ownSubject = randomUUID();
    const foreignSubject = randomUUID();
    const ownAccount = await accountRepository.save(
      accountRepository.create({
        keycloakUserId: ownSubject,
        email: `t064-own-${label}@example.invalid`,
        emailVerified: true,
        selectedPlanId: plan.id,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
    );
    ownAccountId = ownAccount.id;
    const foreignAccount = await accountRepository.save(
      accountRepository.create({
        keycloakUserId: foreignSubject,
        email: `t064-foreign-${label}@example.invalid`,
        emailVerified: true,
        selectedPlanId: plan.id,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
    );
    foreignAccountId = foreignAccount.id;

    const tenantRepository = controlDataSource.getRepository(Tenant);
    const ownTenant = await tenantRepository.save(
      tenantRepository.create({
        accountId: ownAccount.id,
        status: TenantStatus.READY,
        readyAt: new Date(),
        minioBucket: `kemfai-tenant-t064-${label}`,
      }),
    );
    ownTenantId = ownTenant.id;
    const foreignTenant = await tenantRepository.save(
      tenantRepository.create({
        accountId: foreignAccount.id,
        status: TenantStatus.READY,
        readyAt: new Date(),
        minioBucket: `kemfai-tenant-t064-foreign-${label}`,
      }),
    );
    foreignTenantId = foreignTenant.id;

    const subscriptionRepository = controlDataSource.getRepository(Subscription);
    const subscription = await subscriptionRepository.save(
      subscriptionRepository.create({
        tenantId: ownTenant.id,
        planId: plan.id,
        billingCycle: SubscriptionBillingCycle.MONTHLY,
        status: SubscriptionStatus.PENDING_ACTIVATION,
        currentPeriodStart: '2026-10-01',
        currentPeriodEnd: '2026-10-31',
      }),
    );
    subscriptionId = subscription.id;

    const submissionRepository = controlDataSource.getRepository(PaymentSubmission);
    const submission = await submissionRepository.save(
      submissionRepository.create({
        tenantId: ownTenant.id,
        subscriptionId: subscription.id,
        billingPeriodStart: '2026-10-01',
        billingPeriodEnd: '2026-10-31',
        amount: '1250.50',
        currency: 'AED',
        bankReference: `T064-${label}`,
        proofObjectKey: `payment-submissions/t064-${label}/proof.pdf`,
        status: PaymentSubmissionStatus.PENDING_REVIEW,
        statusHistory: [
          {
            status: PaymentSubmissionStatus.PENDING_REVIEW,
            changedAt: new Date().toISOString(),
            changedBy: ownAccount.id,
            notes: null,
          },
        ],
      }),
    );
    submissionId = submission.id;

    const billingAdminSubject = randomUUID();
    const supportSubject = randomUUID();
    tokens.set(
      'owner-own-tenant',
      await customerKeycloak.signAccessToken({
        sub: ownSubject,
        roles: ['WorkspaceOwner'],
        tenantId: ownTenant.id,
      }),
    );
    tokens.set(
      'owner-foreign-tenant',
      await customerKeycloak.signAccessToken({
        sub: foreignSubject,
        roles: ['WorkspaceOwner'],
        tenantId: foreignTenant.id,
      }),
    );
    tokens.set(
      'customer-forged-billing-admin',
      await customerKeycloak.signAccessToken({
        sub: ownSubject,
        roles: ['BillingAdmin'],
        tenantId: ownTenant.id,
      }),
    );
    tokens.set(
      'billing-admin',
      await internalKeycloak.signAccessToken({
        sub: billingAdminSubject,
        roles: ['BillingAdmin'],
      }),
    );
    const supportToken = await internalKeycloak.signAccessToken({
      sub: supportSubject,
      roles: ['Support'],
    });
    for (const key of [
      'support-no-grant',
      'support-active-grant',
      'support-expired-grant',
      'support-revoked-grant',
    ] as const) {
      tokens.set(key, supportToken);
    }
  }, 60_000);

  afterAll(async () => {
    let cleanupError: unknown;
    const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        cleanupError ??= error;
      }
    };

    try {
      // T070 companion hygiene: the billing-admin matrix rows that now reach the real
      // decision routes enqueue notification.billing_decision jobs (approve included —
      // FR-035 covers every decision). Remove every occurrence-keyed job the outbox
      // recorded for this suite's submission so the shared test Redis DB stays clean
      // for T021's queue-emptiness contract — no assertion above is weakened.
      if (submissionId) {
        await attempt(async () => {
          const notificationQueue = new Queue(QUEUE_NOTIFICATION_BILLING_DECISION, {
            connection: redisConnectionFromUrl(),
          });
          try {
            const rows = (await controlDataSource.query(
              'SELECT job_id FROM billing_decision_notification_outbox WHERE submission_id = $1',
              [submissionId],
            )) as Array<{ job_id: string }>;
            for (const row of rows) {
              await notificationQueue.remove(row.job_id).catch(() => undefined);
            }
          } finally {
            await notificationQueue.close().catch(() => undefined);
          }
        });
      }
      if (controlDataSource.isInitialized) {
        for (const tenantId of [ownTenantId, foreignTenantId]) {
          if (!tenantId) continue;
          await attempt(() =>
            controlDataSource.query('DELETE FROM audit_event WHERE tenant_id = $1', [tenantId]),
          );
        }
        if (ownTenantId) {
          await attempt(() =>
            controlDataSource.query(
              'DELETE FROM support_access_usage WHERE grant_id IN (SELECT id FROM support_access_grant WHERE tenant_id = $1)',
              [ownTenantId],
            ),
          );
          await attempt(() =>
            controlDataSource.query('DELETE FROM support_access_grant WHERE tenant_id = $1', [
              ownTenantId,
            ]),
          );
        }
        if (submissionId) {
          await attempt(() =>
            controlDataSource.query('DELETE FROM payment_submission WHERE id = $1', [submissionId]),
          );
        }
        if (subscriptionId) {
          await attempt(() =>
            controlDataSource.query('DELETE FROM subscription WHERE id = $1', [subscriptionId]),
          );
        }
        for (const tenantId of [ownTenantId, foreignTenantId]) {
          if (tenantId) {
            await attempt(() =>
              controlDataSource.query('DELETE FROM tenant WHERE id = $1', [tenantId]),
            );
          }
        }
        for (const accountId of [ownAccountId, foreignAccountId]) {
          if (accountId) {
            await attempt(() =>
              controlDataSource.query('DELETE FROM account WHERE id = $1', [accountId]),
            );
          }
        }
        if (planId) {
          await attempt(() => controlDataSource.query('DELETE FROM plan WHERE id = $1', [planId]));
        }
        await attempt(async () => {
          const residue = await fixtureResidueCount();
          expect(residue).toBe(0);
        });
      }
    } finally {
      if (app) await attempt(() => app.close());
      if (customerKeycloak) await attempt(() => customerKeycloak.close());
      if (internalKeycloak) await attempt(() => internalKeycloak.close());
      if (controlDataSource.isInitialized) {
        await attempt(() => controlDataSource.destroy());
      }
      restoreEnvironment('KEYCLOAK_ISSUER', originalAuthEnvironment.issuer);
      restoreEnvironment('KEYCLOAK_API_AUDIENCE', originalAuthEnvironment.audience);
      restoreEnvironment('KEYCLOAK_JWKS_URI', originalAuthEnvironment.jwksUri);
      restoreEnvironment('KEYCLOAK_INTERNAL_ISSUER', originalAuthEnvironment.internalIssuer);
      restoreEnvironment(
        'KEYCLOAK_INTERNAL_API_AUDIENCE',
        originalAuthEnvironment.internalAudience,
      );
      restoreEnvironment('KEYCLOAK_INTERNAL_JWKS_URI', originalAuthEnvironment.internalJwksUri);
    }

    if (cleanupError) {
      throw cleanupError;
    }
  }, 60_000);

  it('enumerates every /internal/billing/* operation committed in the OpenAPI contract', () => {
    const contract = loadYaml(
      readFileSync(
        resolve(__dirname, '../../../../specs/001-saas-onboarding-shell/contracts/openapi.yaml'),
        'utf8',
      ),
    ) as { paths: Record<string, Record<string, unknown>> };
    const contractedOperations = Object.entries(contract.paths)
      .filter(([path]) => path.startsWith('/internal/billing/'))
      .flatMap(([path, operations]) =>
        Object.keys(operations)
          .filter((method) => ['delete', 'get', 'patch', 'post', 'put'].includes(method))
          .map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    expect(
      ENDPOINTS.map(
        (endpoint) => `${endpoint.method.toUpperCase()} ${endpoint.contractPath}`,
      ).sort(),
    ).toEqual(contractedOperations);
  });

  it('keeps an existing customer route authenticated by the customer realm in the same AppModule', async () => {
    const response = await request(baseUrl)
      .get('/billing/payment-submissions')
      .set('Authorization', `Bearer ${tokens.get('owner-own-tenant')!}`)
      .set('Accept', 'application/json')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Requested-With', 'XMLHttpRequest');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: submissionId,
          status: PaymentSubmissionStatus.PENDING_REVIEW,
        }),
      ]),
    );
  });

  it('rejects an internal-realm BillingAdmin identity from the existing customer route', async () => {
    const response = await request(baseUrl)
      .get('/billing/payment-submissions')
      .set('Authorization', `Bearer ${tokens.get('billing-admin')!}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ statusCode: 401 });
  });

  for (const endpoint of ENDPOINTS) {
    for (const shape of ['ui', 'raw'] as const) {
      for (const actor of ACTORS) {
        it(`${endpoint.label}: ${actor.key} is ${actor.expectedStatus === 200 ? 'allowed' : 'denied'} via ${shape} request`, async () => {
          await resetDecisionState();
          await arrangeSupportGrant(actor.supportGrant ?? 'none');

          const response = await issue(endpoint, shape, tokens.get(actor.key));
          expect(response.status).toBe(actor.expectedStatus);
          if (actor.expectedStatus !== 200) {
            expect(response.body).toMatchObject({ statusCode: actor.expectedStatus });
          }
        });
      }
    }
  }

  async function resetDecisionState(): Promise<void> {
    await controlDataSource.query(
      `UPDATE payment_submission
          SET status = 'PendingReview'::payment_submission_status_enum,
              reviewed_by = NULL,
              reviewed_at = NULL,
              decision_notes = NULL
        WHERE id = $1`,
      [submissionId],
    );
    await controlDataSource.query(
      `UPDATE subscription
          SET status = 'PendingActivation'::subscription_status_enum,
              activated_by = NULL,
              activated_at = NULL
        WHERE id = $1`,
      [subscriptionId],
    );
  }

  async function arrangeSupportGrant(state: SupportGrantState): Promise<void> {
    await controlDataSource.query(
      'DELETE FROM support_access_usage WHERE grant_id IN (SELECT id FROM support_access_grant WHERE tenant_id = $1)',
      [ownTenantId],
    );
    await controlDataSource.query('DELETE FROM support_access_grant WHERE tenant_id = $1', [
      ownTenantId,
    ]);
    if (state === 'none') return;

    const now = Date.now();
    const grantRepository = controlDataSource.getRepository(SupportAccessGrant);
    const grant = await grantRepository.save(
      grantRepository.create({
        tenantId: ownTenantId,
        grantedBy: ownAccountId,
        granteeRole: SupportAccessGranteeRole.SUPPORT,
        expiresAt: new Date(now + (state === 'expired' ? -60_000 : 60_000)),
        revokedAt: state === 'revoked' ? new Date(now) : null,
      }),
    );
    supportGrantIds.add(grant.id);
  }

  function configureBothAuthRealms(): void {
    // Preserve the deployed customer settings. Replacing these with the internal realm would
    // make every customer token fail and would not prove simultaneous trust-domain separation.
    process.env.KEYCLOAK_ISSUER = CUSTOMER_ISSUER;
    process.env.KEYCLOAK_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_JWKS_URI = customerKeycloak.jwksUri;

    // Test-first contract for route-aware authentication. Production does not yet consume these
    // settings or select them for /internal/billing/*; that missing structural implementation is
    // intentionally left RED for the separately scoped implementation work.
    process.env.KEYCLOAK_INTERNAL_ISSUER = INTERNAL_ISSUER;
    process.env.KEYCLOAK_INTERNAL_API_AUDIENCE = AUDIENCE;
    process.env.KEYCLOAK_INTERNAL_JWKS_URI = internalKeycloak.jwksUri;
  }

  async function issue(endpoint: EndpointCase, shape: CallShape, token?: string) {
    const server = request(baseUrl);
    const call =
      endpoint.method === 'get'
        ? server.get(endpoint.runtimePath(submissionId))
        : server.post(endpoint.runtimePath(submissionId));

    if (token) call.set('Authorization', `Bearer ${token}`);
    if (shape === 'ui') {
      call
        .set('Accept', 'application/json')
        .set('Origin', 'http://127.0.0.1')
        .set('X-Requested-With', 'XMLHttpRequest');
    }
    if (endpoint.body) call.send(endpoint.body);
    return call;
  }

  async function fixtureResidueCount(): Promise<number> {
    const scalarCount = async (sql: string, parameters: unknown[]): Promise<number> => {
      const rows = (await controlDataSource.query(sql, parameters)) as Array<{ count: string }>;
      return Number(rows[0].count);
    };
    const tenantIds = [ownTenantId, foreignTenantId].filter(Boolean);
    const accountIds = [ownAccountId, foreignAccountId].filter(Boolean);
    const counts = await Promise.all([
      scalarCount('SELECT COUNT(*)::text AS count FROM plan WHERE id = $1', [planId]),
      scalarCount('SELECT COUNT(*)::text AS count FROM account WHERE id = ANY($1::uuid[])', [
        accountIds,
      ]),
      scalarCount('SELECT COUNT(*)::text AS count FROM tenant WHERE id = ANY($1::uuid[])', [
        tenantIds,
      ]),
      scalarCount('SELECT COUNT(*)::text AS count FROM subscription WHERE id = $1', [
        subscriptionId,
      ]),
      scalarCount('SELECT COUNT(*)::text AS count FROM payment_submission WHERE id = $1', [
        submissionId,
      ]),
      scalarCount(
        'SELECT COUNT(*)::text AS count FROM support_access_grant WHERE tenant_id = ANY($1::uuid[])',
        [tenantIds],
      ),
      scalarCount(
        'SELECT COUNT(*)::text AS count FROM support_access_usage WHERE grant_id = ANY($1::uuid[])',
        [[...supportGrantIds]],
      ),
      scalarCount(
        'SELECT COUNT(*)::text AS count FROM audit_event WHERE tenant_id = ANY($1::uuid[])',
        [tenantIds],
      ),
    ]);
    return counts.reduce((total, count) => total + count, 0);
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
