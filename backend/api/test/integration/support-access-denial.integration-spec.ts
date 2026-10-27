import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { randomUUID } from 'crypto';
import { AppModule } from '../../src/app.module';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';
import { AuditEvent } from '../../src/modules/audit/entities/audit-event.entity';
import { FeatureFlag } from '../../src/modules/entitlements/entities/feature-flag.entity';
import { SupportAccessUsage } from '../../src/modules/support-access/entities/support-access-usage.entity';
import {
  SUPPORT_WORKSPACE_SUMMARY_ACTION,
  SupportAccessGrant,
  SupportAccessGranteeRole,
  SupportAccessGrantStatus,
} from '../../src/modules/support-access/entities/support-access-grant.entity';
import { FakeKeycloak, startFakeKeycloak } from '../support/fake-keycloak';
import { withT093NegativeFixture } from '../support/t093-observer';

describe('support access live denial and audit (T085/T089)', () => {
  const issuer = 'http://127.0.0.1/realms/kemfai-internal-us8';
  const audience = 'kemfai-api-us8';
  const supportUser = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const missingGrantSentinel = '00000000-0000-4000-8000-000000000000';
  let keycloak: FakeKeycloak;
  let app: INestApplication;
  let token: string;
  let wrongRoleToken: string;
  let owner: Account;
  let tenant: Tenant;
  let otherTenant: Tenant;

  beforeAll(async () => {
    keycloak = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_INTERNAL_ISSUER = issuer;
    process.env.KEYCLOAK_INTERNAL_API_AUDIENCE = audience;
    process.env.KEYCLOAK_INTERNAL_JWKS_URI = keycloak.jwksUri;
    if (!controlDataSource.isInitialized) await controlDataSource.initialize();
    await controlDataSource.runMigrations();
    await controlDataSource
      .getRepository(FeatureFlag)
      .update({ featureKey: 'module.support_access' }, { enabled: true });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    token = await keycloak.signAccessToken({ sub: supportUser, roles: ['Support'] });
    wrongRoleToken = await keycloak.signAccessToken({
      sub: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      roles: ['TechnicalAdmin'],
    });
  });
  beforeEach(async () => {
    const accounts = controlDataSource.getRepository(Account);
    const tenants = controlDataSource.getRepository(Tenant);
    owner = await accounts.save({
      keycloakUserId: randomUUID(),
      email: `${randomUUID()}@example.test`,
      emailVerified: true,
    });
    tenant = await tenants.save({ accountId: owner.id, status: TenantStatus.READY });
    const other = await accounts.save({
      keycloakUserId: randomUUID(),
      email: `${randomUUID()}@example.test`,
      emailVerified: true,
    });
    otherTenant = await tenants.save({ accountId: other.id, status: TenantStatus.READY });
  });
  afterEach(async () => {
    await controlDataSource.query(`DELETE FROM audit_event WHERE action LIKE 'support_access.%'`);
    await controlDataSource.query('DELETE FROM support_access_usage');
    await controlDataSource.query('DELETE FROM support_access_grant');
    await controlDataSource.query('DELETE FROM tenant');
    await controlDataSource.query('DELETE FROM account');
  });
  afterAll(async () => {
    await app.close();
    await keycloak.close();
    if (controlDataSource.isInitialized) await controlDataSource.destroy();
  });
  async function grant(expiresAt: Date, revokedAt: Date | null = null) {
    return controlDataSource.getRepository(SupportAccessGrant).save({
      tenantId: tenant.id,
      grantedBy: owner.id,
      granteeRole: SupportAccessGranteeRole.SUPPORT,
      expiresAt,
      revokedAt,
      permittedActions: [SUPPORT_WORKSPACE_SUMMARY_ACTION],
    });
  }
  const call = (tenantId: string, grantId: string) =>
    request(app.getHttpServer())
      .get(`/internal/support-access/workspaces/${tenantId}/summary`)
      .query({ grantId })
      .set('Authorization', `Bearer ${token}`);

  const deniedAudits = () =>
    controlDataSource.getRepository(AuditEvent).findBy({ action: 'support_access.grant.denied' });

  it.each([['expired'], ['revoked']] as const)(
    'denies every %s existing-session attempt and writes usage plus audit every time',
    async (kind) => {
      const row = await grant(
        kind === 'expired' ? new Date(Date.now() - 1000) : new Date(Date.now() + 60_000),
        kind === 'revoked' ? new Date() : null,
      );
      await call(tenant.id, row.id).expect(403);
      await call(tenant.id, row.id).expect(403);
      const usages = await controlDataSource
        .getRepository(SupportAccessUsage)
        .findBy({ grantId: row.id, wasDenied: true });
      const audits = await controlDataSource
        .getRepository(AuditEvent)
        .findBy({ subjectId: row.id, action: 'support_access.grant.denied' });
      expect(usages).toHaveLength(2);
      expect(audits).toHaveLength(2);
      expect(
        usages.every(
          (usage) =>
            usage.denialReason === kind && usage.actionSummary === SUPPORT_WORKSPACE_SUMMARY_ACTION,
        ),
      ).toBe(true);
    },
  );
  it('requires the explicit matching tenant and records wrong-tenant denial without leaking data', async () => {
    const row = await grant(new Date(Date.now() + 60_000));
    await call(otherTenant.id, row.id).expect(403);
    expect(
      await controlDataSource
        .getRepository(SupportAccessUsage)
        .findOneByOrFail({ grantId: row.id }),
    ).toMatchObject({ wasDenied: true, denialReason: 'wrong_tenant' });
  });
  it('audits missing, malformed, unknown-grant, and wrong-internal-role attempts safely', async () => {
    const row = await grant(new Date(Date.now() + 60_000));
    await withT093NegativeFixture(
      'support-denial-grant-required',
      {
        action: 'support_access.grant.denied',
        subjectType: 'support_access_grant',
        subjectId: missingGrantSentinel,
        tenantId: tenant.id,
        payload: { denial_reason: 'grant_required' },
      },
      () =>
        request(app.getHttpServer())
          .get(`/internal/support-access/workspaces/${tenant.id}/summary`)
          .set('Authorization', `Bearer ${token}`)
          .expect(403),
    );
    await withT093NegativeFixture(
      'support-denial-invalid-grant',
      {
        action: 'support_access.grant.denied',
        subjectType: 'support_access_grant',
        subjectId: missingGrantSentinel,
        tenantId: tenant.id,
        payload: { denial_reason: 'invalid_grant' },
      },
      () => call(tenant.id, 'not-a-uuid').expect(403),
    );
    const unknown = randomUUID();
    await withT093NegativeFixture(
      'support-denial-unknown-grant',
      {
        action: 'support_access.grant.denied',
        subjectType: 'support_access_grant',
        subjectId: unknown,
        tenantId: tenant.id,
        payload: { denial_reason: 'unknown_grant' },
      },
      () => call(tenant.id, unknown).expect(403),
    );
    await request(app.getHttpServer())
      .get(`/internal/support-access/workspaces/${tenant.id}/summary`)
      .query({ grantId: row.id })
      .set('Authorization', `Bearer ${wrongRoleToken}`)
      .expect(403);

    const audits = await deniedAudits();
    expect(audits).toHaveLength(4);
    expect(audits.map((event) => event.payload.denial_reason)).toEqual(
      expect.arrayContaining([
        'grant_required',
        'invalid_grant',
        'unknown_grant',
        'action_not_permitted',
      ]),
    );
    expect(JSON.stringify(audits)).not.toMatch(/authorization|bearer|not-a-uuid|query/i);
    expect(
      await controlDataSource
        .getRepository(SupportAccessUsage)
        .countBy({ grantId: row.id, wasDenied: true }),
    ).toBe(1);
  });
  it('hides a disabled internal route before authorization and records no usage or audit', async () => {
    const row = await grant(new Date(Date.now() + 60_000));
    await controlDataSource
      .getRepository(FeatureFlag)
      .update({ featureKey: 'module.support_access' }, { enabled: false });
    await call(tenant.id, row.id).expect(404);
    expect(
      await controlDataSource.getRepository(SupportAccessUsage).countBy({ grantId: row.id }),
    ).toBe(0);
    expect(await controlDataSource.getRepository(AuditEvent).countBy({ subjectId: row.id })).toBe(
      0,
    );
    await controlDataSource
      .getRepository(FeatureFlag)
      .update({ featureKey: 'module.support_access' }, { enabled: true });
  });
  it('serializes revoke versus use so no allowed use can commit after revocation', async () => {
    const row = await grant(new Date(Date.now() + 60_000));
    const revoke = controlDataSource.transaction(async (manager) => {
      const locked = await manager
        .getRepository(SupportAccessGrant)
        .createQueryBuilder('grant')
        .setLock('pessimistic_write')
        .where('grant.id = :id', { id: row.id })
        .getOneOrFail();
      await new Promise((resolve) => setTimeout(resolve, 100));
      locked.status = SupportAccessGrantStatus.REVOKED;
      locked.revokedAt = new Date();
      await manager.save(locked);
      return locked.revokedAt;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const use = call(tenant.id, row.id);
    const [revokedAt, response] = await Promise.all([revoke, use]);
    expect(response.status).toBe(403);
    const usage = await controlDataSource
      .getRepository(SupportAccessUsage)
      .findOneByOrFail({ grantId: row.id });
    expect(usage.wasDenied).toBe(true);
    expect(usage.denialReason).toBe('revoked');
    expect(usage.usedAt.getTime()).toBeGreaterThanOrEqual(revokedAt.getTime());
  });
  it('returns a meaningful safe workspace summary and records each permitted read', async () => {
    const row = await grant(new Date(Date.now() + 60_000));
    const response = await call(tenant.id, row.id).expect(200);
    expect(response.body).toEqual({
      tenantId: tenant.id,
      workspaceStatus: 'Ready',
      subscriptionStatus: null,
      billingCycle: null,
      currentPeriodEnd: null,
    });
    expect(JSON.stringify(response.body)).not.toMatch(/odoo|database|rpc/i);
    expect(
      await controlDataSource
        .getRepository(SupportAccessUsage)
        .countBy({ grantId: row.id, wasDenied: false }),
    ).toBe(1);
  });
});
