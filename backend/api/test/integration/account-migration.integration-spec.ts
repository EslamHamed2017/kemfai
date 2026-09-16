import controlDataSource from '../../src/database/data-source';
import { Account, BillingCycle, Locale } from '../../src/modules/accounts/entities/account.entity';

/**
 * T007 acceptance test. Requires a reachable Postgres configured via CONTROL_DB_* env vars, same
 * convention as T006's control-db-migration.integration-spec.ts.
 */
describe('Account migration + entity (T007)', () => {
  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();
  });

  afterEach(async () => {
    await controlDataSource.query('DELETE FROM "account"');
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) {
      await controlDataSource.destroy();
    }
  });

  it('enforces a unique index on email', async () => {
    const repo = controlDataSource.getRepository(Account);

    await repo.save(
      repo.create({
        keycloakUserId: '11111111-1111-1111-1111-111111111111',
        email: 'owner@example.com',
        emailVerified: false,
        mfaEnrolled: false,
      }),
    );

    await expect(
      repo.save(
        repo.create({
          keycloakUserId: '22222222-2222-2222-2222-222222222222',
          email: 'owner@example.com',
          emailVerified: false,
          mfaEnrolled: false,
        }),
      ),
    ).rejects.toThrow();
  });

  it('treats email as case-insensitively unique (citext)', async () => {
    const repo = controlDataSource.getRepository(Account);

    await repo.save(
      repo.create({
        keycloakUserId: '33333333-3333-3333-3333-333333333333',
        email: 'CaseTest@example.com',
        emailVerified: false,
        mfaEnrolled: false,
      }),
    );

    await expect(
      repo.save(
        repo.create({
          keycloakUserId: '44444444-4444-4444-4444-444444444444',
          email: 'casetest@example.com',
          emailVerified: false,
          mfaEnrolled: false,
        }),
      ),
    ).rejects.toThrow();
  });

  it("matches data-model.md's Account table: persists every documented field verbatim", async () => {
    const repo = controlDataSource.getRepository(Account);

    const saved = await repo.save(
      repo.create({
        keycloakUserId: '55555555-5555-5555-5555-555555555555',
        email: 'full-fields@example.com',
        emailVerified: true,
        mfaEnrolled: true,
        selectedPlanId: '66666666-6666-6666-6666-666666666666',
        selectedBillingCycle: BillingCycle.ANNUAL,
        preferredLocale: Locale.AR,
      }),
    );

    const reloaded = await repo.findOneByOrFail({ id: saved.id });
    expect(reloaded.keycloakUserId).toBe('55555555-5555-5555-5555-555555555555');
    expect(reloaded.email).toBe('full-fields@example.com');
    expect(reloaded.emailVerified).toBe(true);
    expect(reloaded.mfaEnrolled).toBe(true);
    expect(reloaded.selectedPlanId).toBe('66666666-6666-6666-6666-666666666666');
    expect(reloaded.selectedBillingCycle).toBe(BillingCycle.ANNUAL);
    expect(reloaded.preferredLocale).toBe(Locale.AR);
    expect(reloaded.createdAt).toBeInstanceOf(Date);
    expect(reloaded.updatedAt).toBeInstanceOf(Date);
  });

  it('models only the one-way Unverified -> Verified transition (no separate status column)', async () => {
    const columns = await controlDataSource.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'account'`,
    );
    const columnNames = columns.map((c: { column_name: string }) => c.column_name);
    expect(columnNames).toContain('email_verified');
    expect(columnNames).not.toContain('status');
  });

  it('allows selected_plan_id, selected_billing_cycle, and preferred_locale to be null', async () => {
    const repo = controlDataSource.getRepository(Account);

    const saved = await repo.save(
      repo.create({
        keycloakUserId: '77777777-7777-7777-7777-777777777777',
        email: 'nullable-fields@example.com',
        emailVerified: false,
        mfaEnrolled: false,
      }),
    );

    expect(saved.selectedPlanId).toBeNull();
    expect(saved.selectedBillingCycle).toBeNull();
    expect(saved.preferredLocale).toBeNull();
  });
});
