import { randomUUID } from 'crypto';
import controlDataSource from '../../src/database/data-source';
import { Account } from '../../src/modules/accounts/entities/account.entity';
import { AuditActorType, AuditEvent } from '../../src/modules/audit/entities/audit-event.entity';
import { AuditService } from '../../src/modules/audit/audit.service';

/**
 * T055 remediation acceptance test for `uq_audit_event_dedupe_key` (migration
 * `AddAuditEventDedupeKey1789860000000`) — the actual database-enforced convergence
 * guarantee behind `CompanySetupService.completeSetup` always calling
 * `recordCompanySetupCompleted` and `CompanySettingsService.updateSettings` forwarding
 * an `Idempotency-Key`-derived dedupe anchor, instead of either service gating on an
 * in-memory/application-level check. Requires a reachable Postgres configured via
 * CONTROL_DB_* env vars, same convention as `idempotency-key-migration.integration-spec.ts`.
 */
describe('audit_event dedupe_key (T055 remediation)', () => {
  let audit: AuditService;
  let accountId: string;
  let tenantId: string;

  beforeAll(async () => {
    if (!controlDataSource.isInitialized) {
      await controlDataSource.initialize();
    }
    await controlDataSource.runMigrations();
    audit = new AuditService();

    // audit_event.tenant_id carries a real FK to `tenant` (fk_audit_event_tenant) — this
    // fixture's own account/tenant row, used by every `recordCompanySetup*`/
    // `recordCompanySettings*` call below so those inserts satisfy it.
    const accountRepo = controlDataSource.getRepository(Account);
    const account = await accountRepo.save(
      accountRepo.create({
        keycloakUserId: randomUUID(),
        email: `t055-dedupe-${randomUUID()}@example.com`,
        emailVerified: true,
      }),
    );
    accountId = account.id;
    const tenantRows = await controlDataSource.query(
      `INSERT INTO tenant (account_id, status) VALUES ($1, 'Ready'::tenant_status_enum) RETURNING id`,
      [accountId],
    );
    tenantId = tenantRows[0].id as string;
  });

  afterEach(async () => {
    await controlDataSource.query(
      'DELETE FROM "audit_event" WHERE "tenant_id" = $1 OR ("tenant_id" IS NULL AND "dedupe_key" IS NOT NULL) OR "action" IN ($2, $3)',
      [tenantId, 'test.action', 'tenant.provisioning.attempted'],
    );
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) {
      await controlDataSource.query('DELETE FROM "audit_event" WHERE "tenant_id" = $1', [tenantId]);
      await controlDataSource.query('DELETE FROM "tenant" WHERE "id" = $1', [tenantId]);
      await controlDataSource.query('DELETE FROM "account" WHERE "id" = $1', [accountId]);
      await controlDataSource.destroy();
    }
  });

  it('rejects a second row for the same dedupe_key at the database level', async () => {
    const dedupeKey = `test:${randomUUID()}`;
    await controlDataSource.query(
      `INSERT INTO "audit_event" ("actor_type", "actor_id", "tenant_id", "action", "subject_type", "subject_id", "occurred_at", "payload", "dedupe_key")
       VALUES ('system', NULL, NULL, 'test.action', 'test', $1, now(), '{}'::jsonb, $2)`,
      [randomUUID(), dedupeKey],
    );

    await expect(
      controlDataSource.query(
        `INSERT INTO "audit_event" ("actor_type", "actor_id", "tenant_id", "action", "subject_type", "subject_id", "occurred_at", "payload", "dedupe_key")
         VALUES ('system', NULL, NULL, 'test.action', 'test', $1, now(), '{}'::jsonb, $2)`,
        [randomUUID(), dedupeKey],
      ),
    ).rejects.toThrow(/duplicate key value/i);
  });

  it('allows any number of rows with a NULL dedupe_key (every pre-existing action is unaffected)', async () => {
    const subjectId = randomUUID();
    await controlDataSource.query(
      `INSERT INTO "audit_event" ("actor_type", "actor_id", "tenant_id", "action", "subject_type", "subject_id", "occurred_at", "payload")
       VALUES ('system', NULL, NULL, 'tenant.provisioning.attempted', 'tenant', $1, now(), '{}'::jsonb)`,
      [subjectId],
    );
    await expect(
      controlDataSource.query(
        `INSERT INTO "audit_event" ("actor_type", "actor_id", "tenant_id", "action", "subject_type", "subject_id", "occurred_at", "payload")
         VALUES ('system', NULL, NULL, 'tenant.provisioning.attempted', 'tenant', $1, now(), '{}'::jsonb)`,
        [subjectId],
      ),
    ).resolves.not.toThrow();
  });

  it('AuditService.recordCompanySetupCompleted ensures exactly one row across a failure-then-retry sequence (Finding 1), with actor/tenant/source preserved', async () => {
    const input = {
      accountId,
      tenantId,
      companyId: tenantId,
      odooDbName: 'owned-scratch',
      odooCompanyId: 1,
    };

    await audit.recordCompanySetupCompleted(input);
    // The retry that an alreadyComplete=true response triggers in
    // CompanySetupService — must be a harmless no-op, not a duplicate row.
    await audit.recordCompanySetupCompleted(input);

    const rows = await controlDataSource.query(
      'SELECT "action", "subject_type", "tenant_id", "actor_id", "payload" FROM "audit_event" WHERE "tenant_id" = $1 AND "action" = $2',
      [tenantId, 'company.setup.completed'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'company.setup.completed',
      subject_type: 'company',
      tenant_id: tenantId,
      actor_id: accountId,
    });
    expect(rows[0].payload).toMatchObject({ odoo_db_name: 'owned-scratch', odoo_company_id: 1 });
  });

  it('AuditService.recordCompanySetupCompleted converges concurrent/parallel completions to exactly one row (Finding 1)', async () => {
    const input = {
      accountId,
      tenantId,
      companyId: tenantId,
      odooDbName: 'owned-scratch',
      odooCompanyId: 1,
    };

    await Promise.all([
      audit.recordCompanySetupCompleted(input),
      audit.recordCompanySetupCompleted(input),
      audit.recordCompanySetupCompleted(input),
    ]);

    const rows = await controlDataSource.query(
      'SELECT count(*)::int AS count FROM "audit_event" WHERE "tenant_id" = $1 AND "action" = $2',
      [tenantId, 'company.setup.completed'],
    );
    expect(rows[0].count).toBe(1);
  });

  it('AuditService.recordCompanySettingsUpdated with the SAME idempotencyKey converges a failure+lost-response replay to exactly one row (Finding 3)', async () => {
    const baseInput = {
      accountId,
      tenantId,
      companyId: tenantId,
      odooDbName: 'owned-scratch',
      odooCompanyId: 1,
      changedFields: ['legal_name'],
      idempotencyKey: 'client-retry-key',
    };

    await audit.recordCompanySettingsUpdated(baseInput);
    // Lost-response retry with the same client-supplied key.
    await audit.recordCompanySettingsUpdated(baseInput);

    const rows = await controlDataSource.query(
      'SELECT count(*)::int AS count FROM "audit_event" WHERE "tenant_id" = $1 AND "action" = $2',
      [tenantId, 'company.settings.updated'],
    );
    expect(rows[0].count).toBe(1);
  });

  it('AuditService.recordCompanySettingsUpdated WITHOUT an idempotencyKey records each call as a distinct logical edit (unchanged pre-remediation behavior)', async () => {
    const baseInput = {
      accountId,
      tenantId,
      companyId: tenantId,
      odooDbName: 'owned-scratch',
      odooCompanyId: 1,
      changedFields: ['legal_name'],
    };

    await audit.recordCompanySettingsUpdated(baseInput);
    await audit.recordCompanySettingsUpdated(baseInput);

    const rows = await controlDataSource.query(
      'SELECT count(*)::int AS count FROM "audit_event" WHERE "tenant_id" = $1 AND "action" = $2',
      [tenantId, 'company.settings.updated'],
    );
    expect(rows[0].count).toBe(2);
  });

  it('AuditEvent entity exposes dedupe_key as a mapped column', async () => {
    const repo = controlDataSource.getRepository(AuditEvent);
    const dedupeKey = `entity-test:${randomUUID()}`;
    const saved = await repo.save(
      repo.create({
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        tenantId: null,
        action: 'test.entity',
        subjectType: 'test',
        subjectId: randomUUID(),
        occurredAt: new Date(),
        payload: {},
        dedupeKey,
        createdAt: new Date(),
      }),
    );
    const reloaded = await repo.findOneByOrFail({ id: saved.id });
    expect(reloaded.dedupeKey).toBe(dedupeKey);
    await repo.delete({ id: saved.id });
  });
});
