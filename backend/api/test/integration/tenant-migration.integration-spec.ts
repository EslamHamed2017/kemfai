import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { Tenant, TenantStatus } from '../../src/modules/tenants/entities/tenant.entity';

/**
 * T008 acceptance test. Requires a reachable Postgres configured via CONTROL_DB_* env vars, same
 * convention as T006/T007's migration integration specs.
 */
describe('Tenant migration + entity (T008)', () => {
  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();
  });

  afterEach(async () => {
    await controlDataSource.query('DELETE FROM "tenant"');
    await controlDataSource.query('DELETE FROM "account"');
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  async function createAccount(email: string) {
    const accountRepo = controlDataSource.getRepository(Account);
    return accountRepo.save(
      accountRepo.create({
        keycloakUserId: '11111111-1111-1111-1111-111111111111',
        email,
        emailVerified: true,
        mfaEnrolled: false,
      }),
    );
  }

  it('enforces a unique constraint on account_id (idempotent provisioning at the DB level)', async () => {
    const account = await createAccount('owner-a@example.com');
    const tenantRepo = controlDataSource.getRepository(Tenant);

    await tenantRepo.save(tenantRepo.create({ accountId: account.id }));

    await expect(tenantRepo.save(tenantRepo.create({ accountId: account.id }))).rejects.toThrow();
  });

  it('rejects a tenant row referencing a nonexistent account (FK -> Account per data-model.md)', async () => {
    const tenantRepo = controlDataSource.getRepository(Tenant);

    await expect(
      tenantRepo.save(tenantRepo.create({ accountId: '99999999-9999-9999-9999-999999999999' })),
    ).rejects.toThrow();
  });

  it('prevents deleting an Account that still owns a Tenant (referential integrity, ON DELETE RESTRICT)', async () => {
    const account = await createAccount('owner-b@example.com');
    const tenantRepo = controlDataSource.getRepository(Tenant);
    await tenantRepo.save(tenantRepo.create({ accountId: account.id }));

    await expect(
      controlDataSource.query('DELETE FROM "account" WHERE id = $1', [account.id]),
    ).rejects.toThrow();
  });

  it("matches data-model.md's Tenant table: persists every documented field verbatim", async () => {
    const account = await createAccount('owner-c@example.com');
    const tenantRepo = controlDataSource.getRepository(Tenant);

    const saved = await tenantRepo.save(
      tenantRepo.create({
        accountId: account.id,
        status: TenantStatus.CREATING,
        odooDbName: 'kemfai_tenant_abc123',
        minioBucket: 'kemfai-tenant-abc123',
        provisioningAttempts: 2,
        failureReason: null,
      }),
    );

    const reloaded = await tenantRepo.findOneByOrFail({ id: saved.id });
    expect(reloaded.accountId).toBe(account.id);
    expect(reloaded.status).toBe(TenantStatus.CREATING);
    expect(reloaded.odooDbName).toBe('kemfai_tenant_abc123');
    expect(reloaded.minioBucket).toBe('kemfai-tenant-abc123');
    expect(reloaded.provisioningAttempts).toBe(2);
    expect(reloaded.failureReason).toBeNull();
    expect(reloaded.createdAt).toBeInstanceOf(Date);
    expect(reloaded.readyAt).toBeNull();
  });

  it('defaults status to Pending and provisioning_attempts to 0 on creation', async () => {
    const account = await createAccount('owner-d@example.com');
    const tenantRepo = controlDataSource.getRepository(Tenant);

    const saved = await tenantRepo.save(tenantRepo.create({ accountId: account.id }));

    expect(saved.status).toBe(TenantStatus.PENDING);
    expect(saved.provisioningAttempts).toBe(0);
    expect(saved.odooDbName).toBeNull();
    expect(saved.minioBucket).toBeNull();
  });

  it('the status enum matches Pending|Creating|Ready|Failed exactly', async () => {
    const rows = await controlDataSource.query(`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'tenant_status_enum'
      ORDER BY e.enumsortorder
    `);
    const labels = rows.map((r: { enumlabel: string }) => r.enumlabel);
    expect(labels).toEqual(['Pending', 'Creating', 'Ready', 'Failed']);
  });
});
