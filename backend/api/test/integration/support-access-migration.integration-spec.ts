import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import {
  SupportAccessGrant,
  SupportAccessGranteeRole,
} from '../../src/modules/support-access/entities/support-access-grant.entity';
import { SupportAccessUsage } from '../../src/modules/support-access/entities/support-access-usage.entity';
import { Tenant } from '../../src/modules/tenants/entities/tenant.entity';

/**
 * T013 acceptance test. Requires a reachable Postgres configured via CONTROL_DB_* env vars, same
 * convention as T011/T012's migration integration specs.
 */
describe('SupportAccessGrant / SupportAccessUsage migration + entities (T013)', () => {
  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();
  });

  afterEach(async () => {
    await controlDataSource.query('DELETE FROM "support_access_usage"');
    await controlDataSource.query('DELETE FROM "support_access_grant"');
    await controlDataSource.query('DELETE FROM "tenant"');
    await controlDataSource.query('DELETE FROM "account"');
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  async function createAccount(email: string) {
    const repo = controlDataSource.getRepository(Account);
    return repo.save(
      repo.create({
        keycloakUserId: '11111111-1111-1111-1111-111111111111',
        email,
        emailVerified: true,
        mfaEnrolled: false,
      }),
    );
  }

  async function createTenant(accountId: string) {
    const repo = controlDataSource.getRepository(Tenant);
    return repo.save(repo.create({ accountId }));
  }

  async function setupTenant(label: string) {
    const account = await createAccount(`owner-${label}@example.com`);
    const tenant = await createTenant(account.id);
    return { account, tenant };
  }

  it('rejects a grant with a null expires_at at the database level (FR-039 mandatory expiry)', async () => {
    const { account, tenant } = await setupTenant('a');

    await expect(
      controlDataSource.query(
        `INSERT INTO "support_access_grant" ("tenant_id", "granted_by", "grantee_role", "expires_at")
         VALUES ($1, $2, $3, NULL)`,
        [tenant.id, account.id, SupportAccessGranteeRole.SUPPORT],
      ),
    ).rejects.toThrow();
  });

  it('rejects a grant referencing a nonexistent tenant or granting account (FK constraints)', async () => {
    const { account, tenant } = await setupTenant('b');
    const repo = controlDataSource.getRepository(SupportAccessGrant);

    await expect(
      repo.save(
        repo.create({
          tenantId: '99999999-9999-9999-9999-999999999999',
          grantedBy: account.id,
          granteeRole: SupportAccessGranteeRole.SUPPORT,
          expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        }),
      ),
    ).rejects.toThrow();

    await expect(
      repo.save(
        repo.create({
          tenantId: tenant.id,
          grantedBy: '99999999-9999-9999-9999-999999999999',
          granteeRole: SupportAccessGranteeRole.SUPPORT,
          expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        }),
      ),
    ).rejects.toThrow();
  });

  it("matches data-model.md's SupportAccessGrant table: persists every documented field verbatim", async () => {
    const { account, tenant } = await setupTenant('c');
    const repo = controlDataSource.getRepository(SupportAccessGrant);

    const saved = await repo.save(
      repo.create({
        tenantId: tenant.id,
        grantedBy: account.id,
        granteeRole: SupportAccessGranteeRole.BILLING_ADMIN,
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
    );

    const reloaded = await repo.findOneByOrFail({ id: saved.id });
    expect(reloaded.tenantId).toBe(tenant.id);
    expect(reloaded.grantedBy).toBe(account.id);
    expect(reloaded.granteeRole).toBe(SupportAccessGranteeRole.BILLING_ADMIN);
    expect(reloaded.expiresAt).toBeInstanceOf(Date);
    expect(reloaded.revokedAt).toBeNull();
    expect(reloaded.createdAt).toBeInstanceOf(Date);
  });

  it('records revocation via revoked_at without deleting the grant (FR-040)', async () => {
    const { account, tenant } = await setupTenant('d');
    const repo = controlDataSource.getRepository(SupportAccessGrant);

    const saved = await repo.save(
      repo.create({
        tenantId: tenant.id,
        grantedBy: account.id,
        granteeRole: SupportAccessGranteeRole.SUPPORT,
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
    );

    saved.revokedAt = new Date('2026-01-15T00:00:00.000Z');
    await repo.save(saved);

    const reloaded = await repo.findOneByOrFail({ id: saved.id });
    expect(reloaded.revokedAt).toBeInstanceOf(Date);
  });

  it('the grantee_role enum matches BillingAdmin|Support|SuperAdmin|CustomerSuccess|TechnicalAdmin exactly', async () => {
    const rows = await controlDataSource.query(`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'support_access_grantee_role_enum'
      ORDER BY e.enumsortorder
    `);
    const labels = rows.map((r: { enumlabel: string }) => r.enumlabel);
    expect(labels).toEqual([
      'BillingAdmin',
      'Support',
      'SuperAdmin',
      'CustomerSuccess',
      'TechnicalAdmin',
    ]);
  });

  it('rejects a usage row referencing a nonexistent grant (FK constraint)', async () => {
    const usageRepo = controlDataSource.getRepository(SupportAccessUsage);

    await expect(
      usageRepo.save(
        usageRepo.create({
          grantId: '99999999-9999-9999-9999-999999999999',
          usedBy: '22222222-2222-2222-2222-222222222222',
          actionSummary: 'viewed invoice list',
        }),
      ),
    ).rejects.toThrow();
  });

  it("matches data-model.md's SupportAccessUsage table: persists every documented field verbatim for an allowed attempt", async () => {
    const { account, tenant } = await setupTenant('e');
    const grantRepo = controlDataSource.getRepository(SupportAccessGrant);
    const usageRepo = controlDataSource.getRepository(SupportAccessUsage);

    const grant = await grantRepo.save(
      grantRepo.create({
        tenantId: tenant.id,
        grantedBy: account.id,
        granteeRole: SupportAccessGranteeRole.SUPPORT,
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
    );

    const saved = await usageRepo.save(
      usageRepo.create({
        grantId: grant.id,
        usedBy: '22222222-2222-2222-2222-222222222222',
        actionSummary: 'viewed invoice list',
      }),
    );

    const reloaded = await usageRepo.findOneByOrFail({ id: saved.id });
    expect(reloaded.grantId).toBe(grant.id);
    expect(reloaded.usedBy).toBe('22222222-2222-2222-2222-222222222222');
    expect(reloaded.actionSummary).toBe('viewed invoice list');
    expect(reloaded.usedAt).toBeInstanceOf(Date);
    expect(reloaded.wasDenied).toBe(false);
    expect(reloaded.denialReason).toBeNull();
  });

  it('logs a denied attempt with was_denied=true and a denial_reason (FR-041, Acceptance Scenario 8.3)', async () => {
    const { account, tenant } = await setupTenant('f');
    const grantRepo = controlDataSource.getRepository(SupportAccessGrant);
    const usageRepo = controlDataSource.getRepository(SupportAccessUsage);

    const grant = await grantRepo.save(
      grantRepo.create({
        tenantId: tenant.id,
        grantedBy: account.id,
        granteeRole: SupportAccessGranteeRole.SUPPORT,
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      }),
    );

    const saved = await usageRepo.save(
      usageRepo.create({
        grantId: grant.id,
        usedBy: '33333333-3333-3333-3333-333333333333',
        actionSummary: 'attempted to view invoice list',
        wasDenied: true,
        denialReason: 'expired',
      }),
    );

    const reloaded = await usageRepo.findOneByOrFail({ id: saved.id });
    expect(reloaded.wasDenied).toBe(true);
    expect(reloaded.denialReason).toBe('expired');
  });
});
