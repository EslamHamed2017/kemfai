import { Controller, Get, INestApplication, Module, Param } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { Tenant } from '../../src/modules/tenants/entities/tenant.entity';
import {
  SupportAccessGrant,
  SupportAccessGranteeRole,
} from '../../src/modules/support-access/entities/support-access-grant.entity';
import { SupportAccessUsage } from '../../src/modules/support-access/entities/support-access-usage.entity';
import { Roles } from '../../src/common/decorators/roles.decorator';
import { RequireFeatureFlag } from '../../src/common/decorators/feature-flag.decorator';
import { RequireSupportAccess } from '../../src/common/decorators/support-access.decorator';
import { EnforceTrialWindow } from '../../src/common/decorators/trial-window.decorator';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from '../../src/modules/billing-customer/entities/subscription.entity';
import { Feature, FeatureKind } from '../../src/modules/entitlements/entities/feature.entity';
import { Plan } from '../../src/modules/entitlements/entities/plan.entity';
import { PlanSetting } from '../../src/modules/entitlements/entities/plan-setting.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';

/**
 * T018 acceptance test, end to end against the real guard chain (BearerAuthGuard +
 * TenantScopeGuard + RoleGuard), real Postgres reads/writes of SupportAccessGrant/Usage, and
 * real JWKS-verified tokens carrying a `realm_access.roles` claim. Covers the behavior the
 * previous rejected attempt missed: a caller holding the `Support` realm role is NOT
 * authorized by role membership alone — it also needs an active, unexpired, unrevoked grant
 * for the specific tenant being reached, and every attempt (granted or denied) is logged to
 * SupportAccessUsage (FR-005, FR-041).
 */
@Controller('test-role')
class ProbeController {
  @Get('billing-admin-only')
  @Roles('BillingAdmin')
  billingAdminOnly(): { ok: true } {
    return { ok: true };
  }

  @Get('support-only/tenants/:tenantId')
  @Roles('Support')
  @RequireFeatureFlag('module.support_access')
  @RequireSupportAccess('workspace.summary.read')
  @EnforceTrialWindow()
  supportOnly(@Param('tenantId') tenantId: string): { tenantId: string } {
    return { tenantId };
  }

  @Get('unrestricted')
  unrestricted(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const KC_SUPPORT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KC_BILLING_ADMIN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KC_NO_ROLE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('RoleGuard (T018, integration)', () => {
  const issuer = 'http://127.0.0.1/realms/kemfai-internal-role-test';
  const audience = 'kemfai-api-role-test';
  let keycloak: FakeKeycloak;
  let app: INestApplication;
  let tenantId: string;
  let ownerAccountId: string;
  let planId: string;
  let tokenSupport: string;
  let tokenBillingAdmin: string;
  let tokenNoRole: string;

  beforeAll(async () => {
    keycloak = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;

    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();

    // Match the current T111/T112 production guard chain. These are real persisted
    // feature/trial/subscription fixtures: no guard is overridden or bypassed.
    await controlDataSource.getRepository(Feature).upsert(
      {
        key: 'module.support_access',
        displayName: 'Temporary support access (US8)',
        displayNameEn: 'Temporary support access',
        displayNameAr: null,
        kind: FeatureKind.MODULE,
      },
      ['key'],
    );
    await controlDataSource.query('UPDATE feature_flag SET enabled = true WHERE feature_key = $1', [
      'module.support_access',
    ]);
    const plan = await controlDataSource.getRepository(Plan).save({
      name: `T018 guard plan ${Date.now()}`,
      nameEn: 'T018 guard plan',
      nameAr: null,
      published: false,
      monthlyPrice: '0.00',
      annualPrice: '0.00',
      currency: 'USD',
    });
    planId = plan.id;
    await controlDataSource.getRepository(PlanSetting).save({
      planId,
      trialWindowDays: 14,
      autoRestrictUnpaid: true,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, ProbeModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    tokenSupport = await keycloak.signAccessToken({ sub: KC_SUPPORT, roles: ['Support'] });
    tokenBillingAdmin = await keycloak.signAccessToken({
      sub: KC_BILLING_ADMIN,
      roles: ['BillingAdmin'],
    });
    tokenNoRole = await keycloak.signAccessToken({ sub: KC_NO_ROLE });
  });

  beforeEach(async () => {
    const accountRepo = controlDataSource.getRepository(Account);
    const owner = await accountRepo.save(
      accountRepo.create({
        keycloakUserId: '99999999-9999-4999-8999-999999999999',
        email: `owner-${Date.now()}@example.com`,
        emailVerified: true,
      }),
    );
    ownerAccountId = owner.id;
    const tenantRepo = controlDataSource.getRepository(Tenant);
    const tenant = await tenantRepo.save(tenantRepo.create({ accountId: owner.id }));
    tenantId = tenant.id;
    await controlDataSource.getRepository(Subscription).save({
      tenantId,
      planId,
      billingCycle: SubscriptionBillingCycle.MONTHLY,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: '2026-10-01',
      currentPeriodEnd: '2026-10-31',
      activatedAt: new Date(),
      activatedBy: owner.id,
    });
  });

  afterEach(async () => {
    await controlDataSource.query('DELETE FROM "audit_event"');
    await controlDataSource.query('DELETE FROM "support_access_usage"');
    await controlDataSource.query('DELETE FROM "support_access_grant"');
    await controlDataSource.query('DELETE FROM "subscription"');
    await controlDataSource.query('DELETE FROM "tenant"');
    await controlDataSource.query('DELETE FROM "account"');
  });

  afterAll(async () => {
    await app.close();
    await keycloak.close();
    if (controlDataSource.isInitialized) {
      await controlDataSource.query('DELETE FROM "plan" WHERE "id" = $1', [planId]);
      await controlDataSource.query(
        'UPDATE "feature_flag" SET "enabled" = false WHERE "feature_key" = $1',
        ['module.support_access'],
      );
      await controlDataSource.destroy();
    }
    delete process.env.KEYCLOAK_ISSUER;
    delete process.env.KEYCLOAK_API_AUDIENCE;
    delete process.env.KEYCLOAK_JWKS_URI;
  });

  async function grantSupportAccess(overrides: Partial<SupportAccessGrant> = {}) {
    const grantRepo = controlDataSource.getRepository(SupportAccessGrant);
    return grantRepo.save(
      grantRepo.create({
        tenantId,
        grantedBy: ownerAccountId,
        granteeRole: SupportAccessGranteeRole.SUPPORT,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        permittedActions: ['workspace.summary.read'],
        ...overrides,
      }),
    );
  }

  async function usageRows() {
    return controlDataSource.getRepository(SupportAccessUsage).find({ order: { usedAt: 'ASC' } });
  }

  it('passes an unrestricted route (no @Roles()) for any authenticated caller', async () => {
    await request(app.getHttpServer())
      .get('/test-role/unrestricted')
      .set('Authorization', `Bearer ${tokenNoRole}`)
      .expect(200);
  });

  it('allows a caller holding the required non-Support role', async () => {
    await request(app.getHttpServer())
      .get('/test-role/billing-admin-only')
      .set('Authorization', `Bearer ${tokenBillingAdmin}`)
      .expect(200);
  });

  it('denies a caller lacking the required role with 403', async () => {
    await request(app.getHttpServer())
      .get('/test-role/billing-admin-only')
      .set('Authorization', `Bearer ${tokenNoRole}`)
      .expect(403);
  });

  it('denies Support access to a tenant with no grant at all, and writes no usage row', async () => {
    const unknownGrantId = '99999999-9999-4999-8999-999999999999';
    await request(app.getHttpServer())
      .get(`/test-role/support-only/tenants/${tenantId}?grantId=${unknownGrantId}`)
      .set('Authorization', `Bearer ${tokenSupport}`)
      .expect(403);

    expect(await usageRows()).toHaveLength(0);
  });

  it('allows Support access with an active grant and logs a non-denied SupportAccessUsage row', async () => {
    const grant = await grantSupportAccess();

    await request(app.getHttpServer())
      .get(`/test-role/support-only/tenants/${tenantId}?grantId=${grant.id}`)
      .set('Authorization', `Bearer ${tokenSupport}`)
      .expect(200);

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      grantId: grant.id,
      usedBy: KC_SUPPORT,
      wasDenied: false,
      denialReason: null,
    });
  });

  it('denies Support access with an expired grant (403) and logs a denial with reason "expired"', async () => {
    const grant = await grantSupportAccess({ expiresAt: new Date(Date.now() - 60_000) });

    await request(app.getHttpServer())
      .get(`/test-role/support-only/tenants/${tenantId}?grantId=${grant.id}`)
      .set('Authorization', `Bearer ${tokenSupport}`)
      .expect(403);

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ grantId: grant.id, wasDenied: true, denialReason: 'expired' });
  });

  it('denies Support access with a revoked grant (403) and logs a denial with reason "revoked"', async () => {
    const grant = await grantSupportAccess({ revokedAt: new Date() });

    await request(app.getHttpServer())
      .get(`/test-role/support-only/tenants/${tenantId}?grantId=${grant.id}`)
      .set('Authorization', `Bearer ${tokenSupport}`)
      .expect(403);

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ grantId: grant.id, wasDenied: true, denialReason: 'revoked' });
  });

  it('does not authorize Support access by realm-role membership alone even when other tenants have active grants', async () => {
    // A grant for a DIFFERENT tenant must not authorize access to this one.
    const otherAccountRepo = controlDataSource.getRepository(Account);
    const otherOwner = await otherAccountRepo.save(
      otherAccountRepo.create({
        keycloakUserId: '88888888-8888-4888-8888-888888888888',
        email: `other-owner-${Date.now()}@example.com`,
        emailVerified: true,
      }),
    );
    const otherTenantRepo = controlDataSource.getRepository(Tenant);
    const otherTenant = await otherTenantRepo.save(
      otherTenantRepo.create({ accountId: otherOwner.id }),
    );
    const grantRepo = controlDataSource.getRepository(SupportAccessGrant);
    const otherGrant = await grantRepo.save(
      grantRepo.create({
        tenantId: otherTenant.id,
        grantedBy: otherOwner.id,
        granteeRole: SupportAccessGranteeRole.SUPPORT,
        expiresAt: new Date(Date.now() + 60_000),
        permittedActions: ['workspace.summary.read'],
      }),
    );

    await request(app.getHttpServer())
      .get(`/test-role/support-only/tenants/${tenantId}?grantId=${otherGrant.id}`)
      .set('Authorization', `Bearer ${tokenSupport}`)
      .expect(403);

    expect(await usageRows()).toMatchObject([{ wasDenied: true, denialReason: 'wrong_tenant' }]);
  });
});
