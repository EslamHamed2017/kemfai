import { randomUUID } from 'crypto';
import {
  ConflictException,
  InternalServerErrorException,
  PreconditionFailedException,
} from '@nestjs/common';
import controlDataSource from '../../src/database/data-source';
import { Account, BillingCycle } from '../../src/modules/accounts/entities/account.entity';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CompanySetupService } from '../../src/modules/company-setup/company-setup.service';
import { CompanySettingsService } from '../../src/modules/company-setup/company-settings.service';
import { CompanyMutationHandoffService } from '../../src/modules/company-setup/company-mutation-handoff.service';
import { CompanyMutationRecoveryWorker } from '../../src/modules/company-setup/company-mutation-recovery.worker';
import { CompanyMutationHandoffState } from '../../src/modules/company-setup/entities/company-mutation-handoff.entity';
import { CompanyOdooContextService } from '../../src/modules/company-setup/company-odoo-context.service';
import { computeCompanySetupScope } from '../../src/modules/company-setup/company-setup-scope.util';
import { OdooRpcService } from '../../src/integrations/odoo-rpc/odoo-rpc.service';
import { TenantScopedRequest } from '../../src/common/tenant-context/tenant-context.model';

/**
 * T055 arbiter binding resolution, point 6 (Tier 1 of two — see
 * `scripts/test_t055_durable_handoff.sh`'s header and `scripts/test_t054_live.sh`'s
 * Phase 4.5 for Tier 2's real-HTTP/real-Odoo proof of the SAME protocol).
 *
 * This tier runs the REAL `CompanyMutationHandoffService`, `AuditService`, and
 * `CompanyMutationRecoveryWorker` — unmodified production code, real SQL — against a
 * freshly created, owned scratch PostgreSQL (never the shared dev `kemfai_control`),
 * gated by `KEMFAI_LIVE_T055_HANDOFF=1` exactly like `KEMFAI_LIVE_T054` gates the T054/
 * T055 HTTP harness. The Odoo RPC boundary is the one thing stubbed here (a plain
 * `jest.fn()` standing in for `OdooRpcService.executeKw`) — Odoo's own idempotent-receipt
 * behavior is proven for real in `backend/addons/kemfai_company_setup/tests/
 * test_company_setup.py`, and the full HTTP->Odoo->audit path is proven for real in
 * Tier 2. What this tier proves that NEITHER of those can on its own: the control-plane
 * durability guarantees — handoff uniqueness, lease-based recovery claiming, bounded
 * backoff, exactly-one-audit-event-under-concurrency, and original-actor/time
 * preservation — hold against a real Postgres instance, not a mock of one.
 */
const live = process.env.KEMFAI_LIVE_T055_HANDOFF === '1' ? describe : describe.skip;

live('T055 durable-handoff application-level regressions (real scratch Postgres)', () => {
  const handoffs = new CompanyMutationHandoffService();
  const auditService = new AuditService();

  let tenantAId: string;
  let accountAId: string;
  let tenantBId: string;
  let accountBId: string;
  let planId: string;

  async function makeTenant(): Promise<{ accountId: string; tenantId: string }> {
    const accountRepo = controlDataSource.getRepository(Account);
    const account = await accountRepo.save(
      accountRepo.create({
        keycloakUserId: randomUUID(),
        email: `t055-handoff-${randomUUID()}@example.com`,
        emailVerified: true,
        selectedPlanId: planId,
        selectedBillingCycle: BillingCycle.MONTHLY,
      }),
    );
    const rows = await controlDataSource.query(
      `INSERT INTO tenant (account_id, status, odoo_db_name, ready_at)
       VALUES ($1, 'Ready'::tenant_status_enum, 'scratch_db_unused', now()) RETURNING id`,
      [account.id],
    );
    return { accountId: account.id, tenantId: rows[0].id as string };
  }

  async function countAuditEvents(action: string, tenantId: string): Promise<number> {
    const rows = await controlDataSource.query(
      'SELECT count(*)::int AS count FROM audit_event WHERE tenant_id = $1 AND action = $2',
      [tenantId, action],
    );
    return rows[0].count as number;
  }

  // The legacy `resolve()` path and the split request-path methods MUST agree with
  // `resolveByTenantId()` (worker recovery): every handoff in this suite is stored with
  // odooDbName 'scratch_db_unused'/odooCompanyId 7, and B3 requires the worker to verify
  // its resolved target against exactly those stored values before replaying.
  function fakeContext(tenantId: string, accountId: string): CompanyOdooContextService {
    return {
      resolve: async () => ({
        db: 'scratch_db_unused',
        uid: 1,
        password: 'test-only-password',
        companyId: 7,
      }),
      resolveTenantContext: async (req: TenantScopedRequest) => {
        const ctx = { keycloakUserId: randomUUID(), accountId, callerTenantId: tenantId };
        req.tenantContext = ctx;
        return ctx;
      },
      resolveCompanyTarget: async () => 7,
      resolveCredentials: async () => ({
        db: 'scratch_db_unused',
        uid: 1,
        password: 'test-only-password',
      }),
      resolveByTenantId: async () => ({
        db: 'scratch_db_unused',
        uid: 1,
        password: 'test-only-password',
        companyId: 7,
      }),
    } as unknown as CompanyOdooContextService;
  }

  // A context whose worker-side resolution deliberately diverges from the handoff's
  // immutable stored target (B3) — used to prove the worker never dispatches the RPC
  // when the resolved mapping no longer matches.
  function mismatchedContext(tenantId: string, accountId: string): CompanyOdooContextService {
    return {
      resolve: async () => ({ db: 'scratch_db_unused', uid: 1, password: 'pw', companyId: 7 }),
      resolveTenantContext: async (req: TenantScopedRequest) => {
        const ctx = { keycloakUserId: randomUUID(), accountId, callerTenantId: tenantId };
        req.tenantContext = ctx;
        return ctx;
      },
      resolveByTenantId: async () => ({
        db: 'a-different-database',
        uid: 1,
        password: 'pw',
        companyId: 999,
      }),
    } as unknown as CompanyOdooContextService;
  }

  function fakeReq(headers: Record<string, string | undefined> = {}): TenantScopedRequest {
    return {
      headers,
      auth: { keycloakUserId: randomUUID() },
    } as unknown as TenantScopedRequest;
  }

  function setupScope(tenantId: string, accountId: string): string {
    return computeCompanySetupScope(tenantId, accountId, 7);
  }

  function validCompletionResult() {
    const result = {
      alreadyComplete: false,
      setupComplete: true,
      values: {},
      version: 1,
      currentStep: 'accounting_setup',
      stale: false,
    };
    CompanySetupService.assertValidCompletionResult(result);
    return result;
  }

  beforeAll(async () => {
    if (!controlDataSource.isInitialized) await controlDataSource.initialize();
    const plans = await controlDataSource.query(
      `INSERT INTO plan (name, name_en, name_ar, published, monthly_price, annual_price, currency)
       VALUES ($1, $1, $1, true, '10.00', '100.00', 'USD') RETURNING id`,
      [`plan-t055-handoff-${randomUUID()}`],
    );
    planId = plans[0].id as string;
    const a = await makeTenant();
    tenantAId = a.tenantId;
    accountAId = a.accountId;
    const b = await makeTenant();
    tenantBId = b.tenantId;
    accountBId = b.accountId;
  }, 60000);

  afterAll(async () => {
    await controlDataSource.query(
      'DELETE FROM company_mutation_handoff WHERE tenant_id IN ($1, $2)',
      [tenantAId, tenantBId],
    );
    await controlDataSource.query('DELETE FROM audit_event WHERE tenant_id IN ($1, $2)', [
      tenantAId,
      tenantBId,
    ]);
    await controlDataSource.query('DELETE FROM tenant WHERE id IN ($1, $2)', [
      tenantAId,
      tenantBId,
    ]);
    await controlDataSource.query('DELETE FROM account WHERE id IN ($1, $2)', [
      accountAId,
      accountBId,
    ]);
    await controlDataSource.query('DELETE FROM plan WHERE id = $1', [planId]);
    if (controlDataSource.isInitialized) await controlDataSource.destroy();
  }, 30000);

  afterEach(async () => {
    await controlDataSource.query(
      'DELETE FROM company_mutation_handoff WHERE tenant_id IN ($1, $2)',
      [tenantAId, tenantBId],
    );
    await controlDataSource.query('DELETE FROM audit_event WHERE tenant_id IN ($1, $2)', [
      tenantAId,
      tenantBId,
    ]);
  });

  // -- Scenario: process interruption AFTER the Odoo RPC committed ---------------------
  // Simulates a crash/lost-response window by directly marking the handoff
  // `odoo_committed` (as `completeSetup` would have, right after its Odoo call returns)
  // WITHOUT ever calling the audit append that normally follows in the same request —
  // exactly the state a real crash/lost-response leaves behind. The worker must recover
  // it to `audited` with exactly one event, WITHOUT any further HTTP/service call.

  it('autonomous worker recovery: an odoo_committed handoff is audited exactly once, without any further request, preserving the original actor/time', async () => {
    const executeKw = jest.fn();
    const odoo = { executeKw } as unknown as OdooRpcService;
    const worker = new CompanyMutationRecoveryWorker(
      handoffs,
      fakeContext(tenantAId, accountAId),
      odoo,
      auditService,
    );

    const occurredAt = new Date('2026-09-01T00:00:00.000Z');
    const handoff = await handoffs.findOrCreateCompletionHandoff({
      tenantId: tenantAId,
      actorAccountId: accountAId,
      principalIdentity: 'sub-original',
      odooDbName: 'scratch_db_unused',
      odooCompanyId: 7,
      requestFingerprint: 'setup.complete',
      requestPayload: {},
    });
    // Backdate occurred_at directly (the original request's own time), simulating a
    // completion that genuinely happened in the past, recovered much later.
    await controlDataSource.query(
      'UPDATE company_mutation_handoff SET occurred_at = $2 WHERE id = $1',
      [handoff.id, occurredAt],
    );
    const finalResponse = validCompletionResult();
    await handoffs.markOdooCommitted(handoff.id, finalResponse);

    // Worker runs with NO HTTP/service call preceding it — this is the entire recovery.
    await worker.tick();

    expect(executeKw).not.toHaveBeenCalled(); // already odoo_committed: no re-RPC
    const events = await controlDataSource.query(
      'SELECT actor_id, occurred_at FROM audit_event WHERE tenant_id = $1 AND action = $2',
      [tenantAId, 'company.setup.completed'],
    );
    expect(events).toHaveLength(1);
    expect(events[0].actor_id).toBe(accountAId);
    expect(new Date(events[0].occurred_at as string).toISOString()).toBe(occurredAt.toISOString());

    const refreshed = await controlDataSource.query(
      'SELECT state FROM company_mutation_handoff WHERE id = $1',
      [handoff.id],
    );
    expect(refreshed[0].state).toBe(CompanyMutationHandoffState.AUDITED);
  });

  it('autonomous worker recovery: a pending handoff (process crashed before the Odoo call) replays the SAME operation UUID with its stored payload', async () => {
    const executeKw = jest.fn().mockResolvedValue({
      values: { legal_name: 'Recovered' },
      setupComplete: true,
      changedFields: ['legal_name'],
    });
    const odoo = { executeKw } as unknown as OdooRpcService;
    const worker = new CompanyMutationRecoveryWorker(
      handoffs,
      fakeContext(tenantAId, accountAId),
      odoo,
      auditService,
    );

    const handoff = await handoffs.findOrCreateSettingsHandoff({
      tenantId: tenantAId,
      actorAccountId: accountAId,
      principalIdentity: 'sub-original',
      odooDbName: 'scratch_db_unused',
      odooCompanyId: 7,
      requestFingerprint: 'fp-1',
      requestPayload: { legal_name: 'Recovered' },
      idempotencyKey: null,
      callerScope: null,
      method: 'PUT',
      route: '/companies/current/settings',
    });

    await worker.tick();

    expect(executeKw).toHaveBeenCalledWith(
      'scratch_db_unused',
      1,
      'test-only-password',
      'res.company',
      'kemfai_settings_update',
      [[7], { legal_name: 'Recovered' }, handoff.id, handoff.occurredAt.toISOString(), accountAId],
    );
    const events = await countAuditEvents('company.settings.updated', tenantAId);
    expect(events).toBe(1);
  });

  it('audit-store failure after Odoo commit is recovered by the worker on its next tick, exactly one event', async () => {
    const executeKw = jest.fn();
    const odoo = { executeKw } as unknown as OdooRpcService;
    const worker = new CompanyMutationRecoveryWorker(
      handoffs,
      fakeContext(tenantAId, accountAId),
      odoo,
      auditService,
    );

    const handoff = await handoffs.findOrCreateCompletionHandoff({
      tenantId: tenantAId,
      actorAccountId: accountAId,
      principalIdentity: 'sub-original',
      odooDbName: 'scratch_db_unused',
      odooCompanyId: 7,
      requestFingerprint: 'setup.complete',
      requestPayload: {},
    });
    await handoffs.markOdooCommitted(handoff.id, validCompletionResult());

    const appendSpy = jest
      .spyOn(auditService, 'recordCompanySetupCompleted')
      .mockRejectedValueOnce(new Error('INJECTED_AUDIT_STORE_FAILURE'));

    await worker.tick();
    let refreshed = await controlDataSource.query(
      'SELECT state FROM company_mutation_handoff WHERE id = $1',
      [handoff.id],
    );
    expect(refreshed[0].state).toBe(CompanyMutationHandoffState.ODOO_COMMITTED);

    // Clear the backoff window so the next tick can reclaim immediately (deliberately
    // not waiting out the real backoff interval — the backoff MECHANISM isn't under
    // test here, only that a cleared backoff window lets recovery succeed).
    await controlDataSource.query(
      'UPDATE company_mutation_handoff SET next_attempt_at = NULL WHERE id = $1',
      [handoff.id],
    );
    await worker.tick();

    refreshed = await controlDataSource.query(
      'SELECT state FROM company_mutation_handoff WHERE id = $1',
      [handoff.id],
    );
    expect(refreshed[0].state).toBe(CompanyMutationHandoffState.AUDITED);
    expect(await countAuditEvents('company.setup.completed', tenantAId)).toBe(1);
    appendSpy.mockRestore();
  });

  // -- B1/B2 mandatory fault coverage: the REAL service methods observe the failure ----
  // The three cases below go THROUGH `CompanySetupService.completeSetup` /
  // `CompanySettingsService.updateSettings` themselves — never a manually-seeded
  // `markOdooCommitted` row — so they exercise the exact catch block B1 fixed.

  it('B1/B2: completeSetup observes an ambiguous RPC failure AFTER Odoo already committed — the handoff survives, the worker recovers via replay, exactly one audit event, caller gets a typed 5xx', async () => {
    let callCount = 0;
    const executeKw = jest.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        // Simulates Odoo committing the mutation + same-transaction receipt, then the
        // RESPONSE being lost in transit — a transport failure, never a typed
        // KEMFAI_ fault. This is the exact ambiguous scenario B1 must never resolve by
        // deleting the handoff.
        throw new Error('ECONNRESET: response lost after dispatch');
      }
      return validCompletionResult();
    });
    const odoo = { executeKw } as unknown as OdooRpcService;
    const context = fakeContext(tenantAId, accountAId);
    const resolveCredentials = jest.spyOn(context, 'resolveCredentials');
    const service = new CompanySetupService(context, odoo, auditService, handoffs);

    // Missing and stale scopes fail before credential resolution, Odoo mutation, or
    // durable-handoff creation. These calls also prove the injected transport fault
    // below is reached only after a correctly scoped request crosses the precondition.
    await expect(service.completeSetup(fakeReq())).rejects.toThrow(PreconditionFailedException);
    await expect(
      service.completeSetup(fakeReq(), setupScope(tenantBId, accountBId)),
    ).rejects.toThrow(PreconditionFailedException);
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(executeKw).not.toHaveBeenCalled();
    const preconditionRows = await controlDataSource.query(
      "SELECT id FROM company_mutation_handoff WHERE tenant_id = $1 AND action = 'setup.complete'",
      [tenantAId],
    );
    expect(preconditionRows).toHaveLength(0);

    await expect(
      service.completeSetup(fakeReq(), setupScope(tenantAId, accountAId)),
    ).rejects.toThrow(InternalServerErrorException);

    // Captured from the handoff the REAL service call created, BEFORE the worker's
    // replay RPC fires below — this is the "original" against which the recovered
    // audit event's provenance is checked, not a value re-derived after recovery.
    const rows = await controlDataSource.query(
      "SELECT id, state, occurred_at, odoo_db_name, odoo_company_id FROM company_mutation_handoff WHERE tenant_id = $1 AND action = 'setup.complete'",
      [tenantAId],
    );
    expect(rows).toHaveLength(1); // the handoff SURVIVES — never deleted
    expect(rows[0].state).toBe('pending');
    const handoffId = rows[0].id as string;
    const originalOccurredAt = rows[0].occurred_at as string;
    const originalOdooDbName = rows[0].odoo_db_name as string;
    const originalOdooCompanyId = rows[0].odoo_company_id as number;

    // Autonomous worker recovery — NO further HTTP/service call precedes this.
    const worker = new CompanyMutationRecoveryWorker(
      handoffs,
      fakeContext(tenantAId, accountAId),
      odoo,
      auditService,
    );
    await worker.tick();

    expect(executeKw).toHaveBeenCalledTimes(2);
    expect(executeKw.mock.calls[1][4]).toBe('kemfai_setup_complete');
    expect(executeKw.mock.calls[1][5][1]).toBe(handoffId); // SAME operation UUID replayed

    const events = await controlDataSource.query(
      'SELECT actor_id, occurred_at, payload FROM audit_event WHERE tenant_id = $1 AND action = $2',
      [tenantAId, 'company.setup.completed'],
    );
    expect(events).toHaveLength(1); // exactly one audit event
    expect(events[0].actor_id).toBe(accountAId); // original actor preserved
    // The recovered event preserves the ORIGINAL handoff's occurred_at and Odoo
    // db/company source — proving preservation across the same-operation-UUID replay,
    // not just a coincidence of a separately seeded row.
    expect(new Date(events[0].occurred_at as string).toISOString()).toBe(
      new Date(originalOccurredAt).toISOString(),
    );
    expect(events[0].payload.odoo_db_name).toBe(originalOdooDbName);
    expect(events[0].payload.odoo_company_id).toBe(originalOdooCompanyId);

    const refreshed = await controlDataSource.query(
      'SELECT state FROM company_mutation_handoff WHERE id = $1',
      [handoffId],
    );
    expect(refreshed[0].state).toBe(CompanyMutationHandoffState.AUDITED);
  });

  it('B1/B2: updateSettings observes an ambiguous RPC failure AFTER Odoo already committed — the handoff survives, the worker recovers via replay, exactly one audit event, caller gets a typed 5xx', async () => {
    let callCount = 0;
    // The ORIGINAL committed Odoo result — what the (lost) first response would have
    // carried. The recovered audit event's `changed_fields` must match THIS, not
    // whatever the replay call happens to return.
    const committedResult = {
      values: { legal_name: 'Ambiguous' },
      setupComplete: true,
      changedFields: ['legal_name'],
    };
    const executeKw = jest.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('ETIMEDOUT: response lost after dispatch');
      }
      return committedResult;
    });
    const odoo = { executeKw } as unknown as OdooRpcService;
    const service = new CompanySettingsService(
      fakeContext(tenantAId, accountAId),
      odoo,
      auditService,
      handoffs,
    );

    await expect(
      service.updateSettings(fakeReq(), { values: { legal_name: 'Ambiguous' } }),
    ).rejects.toThrow(InternalServerErrorException);

    // Captured from the handoff the REAL service call created, BEFORE the worker's
    // replay RPC fires below — this is the "original" against which the recovered
    // audit event's provenance is checked, not a value re-derived after recovery.
    const rows = await controlDataSource.query(
      "SELECT id, state, actor_account_id, occurred_at, odoo_db_name, odoo_company_id FROM company_mutation_handoff WHERE tenant_id = $1 AND action = 'settings.update'",
      [tenantAId],
    );
    expect(rows).toHaveLength(1); // the handoff SURVIVES — never deleted
    expect(rows[0].state).toBe('pending');
    const handoffId = rows[0].id as string;
    const originalActorAccountId = rows[0].actor_account_id as string;
    const originalOccurredAt = rows[0].occurred_at as string;
    const originalOdooDbName = rows[0].odoo_db_name as string;
    const originalOdooCompanyId = rows[0].odoo_company_id as number;

    const worker = new CompanyMutationRecoveryWorker(
      handoffs,
      fakeContext(tenantAId, accountAId),
      odoo,
      auditService,
    );
    await worker.tick();

    expect(executeKw).toHaveBeenCalledTimes(2);
    expect(executeKw.mock.calls[1][4]).toBe('kemfai_settings_update');
    expect(executeKw.mock.calls[1][5][2]).toBe(handoffId); // SAME operation UUID replayed

    const events = await controlDataSource.query(
      'SELECT actor_id, occurred_at, payload FROM audit_event WHERE tenant_id = $1 AND action = $2',
      [tenantAId, 'company.settings.updated'],
    );
    expect(events).toHaveLength(1); // exactly one audit event
    expect(events[0].actor_id).toBe(originalActorAccountId); // original actor preserved
    // The recovered event preserves the ORIGINAL handoff's occurred_at, Odoo
    // db/company source, and the changedFields from the committed Odoo result — proving
    // preservation across the same-operation-UUID replay, not just a coincidence of a
    // separately seeded row.
    expect(new Date(events[0].occurred_at as string).toISOString()).toBe(
      new Date(originalOccurredAt).toISOString(),
    );
    expect(events[0].payload.odoo_db_name).toBe(originalOdooDbName);
    expect(events[0].payload.odoo_company_id).toBe(originalOdooCompanyId);
    expect(events[0].payload.changed_fields).toEqual(committedResult.changedFields);

    const refreshed = await controlDataSource.query(
      'SELECT state FROM company_mutation_handoff WHERE id = $1',
      [handoffId],
    );
    expect(refreshed[0].state).toBe(CompanyMutationHandoffState.AUDITED);
  });

  it('B2: process interruption after Odoo commit (crash before the audit append) through the REAL service — worker recovers without any HTTP retry', async () => {
    const executeKw = jest.fn().mockResolvedValue(validCompletionResult());
    const odoo = { executeKw } as unknown as OdooRpcService;
    const service = new CompanySetupService(
      fakeContext(tenantAId, accountAId),
      odoo,
      auditService,
      handoffs,
    );

    // Odoo's RPC genuinely succeeds (mutation + receipt committed), but the process
    // dies / the audit append itself fails — the exact window between
    // `markOdooCommitted` and `markAudited` in `completeSetup`.
    const appendSpy = jest
      .spyOn(auditService, 'recordCompanySetupCompleted')
      .mockRejectedValueOnce(new Error('INJECTED_PROCESS_CRASH'));

    await expect(
      service.completeSetup(fakeReq(), setupScope(tenantAId, accountAId)),
    ).rejects.toThrow('INJECTED_PROCESS_CRASH');
    appendSpy.mockRestore();

    const rows = await controlDataSource.query(
      "SELECT id, state FROM company_mutation_handoff WHERE tenant_id = $1 AND action = 'setup.complete'",
      [tenantAId],
    );
    expect(rows).toHaveLength(1);
    // Exactly the state the REAL service's own commit step left it in — never deleted,
    // never advanced past what actually happened.
    expect(rows[0].state).toBe(CompanyMutationHandoffState.ODOO_COMMITTED);
    const handoffId = rows[0].id as string;

    // Autonomous worker recovery — NO further HTTP/service call, no client retry.
    const worker = new CompanyMutationRecoveryWorker(
      handoffs,
      fakeContext(tenantAId, accountAId),
      odoo,
      auditService,
    );
    await worker.tick();

    expect(executeKw).toHaveBeenCalledTimes(1); // already odoo_committed: no re-RPC
    expect(await countAuditEvents('company.setup.completed', tenantAId)).toBe(1);
    const refreshed = await controlDataSource.query(
      'SELECT state FROM company_mutation_handoff WHERE id = $1',
      [handoffId],
    );
    expect(refreshed[0].state).toBe(CompanyMutationHandoffState.AUDITED);
  });

  it("B3: a worker whose resolved Odoo target no longer matches the handoff's stored db/company performs no replay mutation", async () => {
    const executeKw = jest.fn();
    const odoo = { executeKw } as unknown as OdooRpcService;

    const handoff = await handoffs.findOrCreateCompletionHandoff({
      tenantId: tenantAId,
      actorAccountId: accountAId,
      principalIdentity: 'sub-original',
      odooDbName: 'scratch_db_unused',
      odooCompanyId: 7,
      requestFingerprint: 'setup.complete',
      requestPayload: {},
    });

    const worker = new CompanyMutationRecoveryWorker(
      handoffs,
      mismatchedContext(tenantAId, accountAId),
      odoo,
      auditService,
    );
    await worker.tick();

    expect(executeKw).not.toHaveBeenCalled(); // no replay mutation against the wrong target
    const refreshed = await controlDataSource.query(
      'SELECT state FROM company_mutation_handoff WHERE id = $1',
      [handoff.id],
    );
    expect(refreshed[0].state).toBe('pending'); // left for retry, never advanced
    expect(await countAuditEvents('company.setup.completed', tenantAId)).toBe(0);
  });

  it('exactly one company_mutation_handoff row (and exactly one audit event) is created under concurrent completion requests for the same tenant', async () => {
    const executeKw = jest.fn().mockImplementation(async () => validCompletionResult());
    const odoo = { executeKw } as unknown as OdooRpcService;
    const service = new CompanySetupService(
      fakeContext(tenantAId, accountAId),
      odoo,
      auditService,
      handoffs,
    );

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.completeSetup(fakeReq(), setupScope(tenantAId, accountAId)),
      ),
    );
    results.forEach((r) => expect(r.setupComplete).toBe(true));

    const handoffRows = await controlDataSource.query(
      "SELECT id FROM company_mutation_handoff WHERE tenant_id = $1 AND action = 'setup.complete'",
      [tenantAId],
    );
    expect(handoffRows).toHaveLength(1);
    expect(await countAuditEvents('company.setup.completed', tenantAId)).toBe(1);
  });

  // -- Settings Idempotency-Key scope reconciliation (arbiter resolution point 5) -------

  it('same scoped key + same fingerprint replays the stored response (no second Odoo call, no second audit event)', async () => {
    const executeKw = jest.fn().mockResolvedValue({
      values: { legal_name: 'Same' },
      setupComplete: true,
      changedFields: ['legal_name'],
    });
    const odoo = { executeKw } as unknown as OdooRpcService;
    const service = new CompanySettingsService(
      fakeContext(tenantAId, accountAId),
      odoo,
      auditService,
      handoffs,
    );
    const req = fakeReq({ 'idempotency-key': 'key-replay-1' });
    const body = { values: { legal_name: 'Same' } };

    const first = await service.updateSettings(req, body);
    const second = await service.updateSettings(req, body);

    expect(second).toEqual(first);
    expect(executeKw).toHaveBeenCalledTimes(1);
    expect(await countAuditEvents('company.settings.updated', tenantAId)).toBe(1);
  });

  it('same scoped key + different fingerprint is rejected with 409, never mutates, never audits', async () => {
    const executeKw = jest.fn().mockResolvedValue({
      values: { legal_name: 'First' },
      setupComplete: true,
      changedFields: ['legal_name'],
    });
    const odoo = { executeKw } as unknown as OdooRpcService;
    const service = new CompanySettingsService(
      fakeContext(tenantAId, accountAId),
      odoo,
      auditService,
      handoffs,
    );
    const req = fakeReq({ 'idempotency-key': 'key-conflict-1' });
    await service.updateSettings(req, { values: { legal_name: 'First' } });

    await expect(
      service.updateSettings(req, { values: { legal_name: 'Different' } }),
    ).rejects.toThrow(ConflictException);
    expect(executeKw).toHaveBeenCalledTimes(1); // the second (rejected) call never reached Odoo
    expect(await countAuditEvents('company.settings.updated', tenantAId)).toBe(1);
  });

  it('two distinct authorized callers reusing the identical literal Idempotency-Key are never collapsed into one handoff/event', async () => {
    const executeKw = jest.fn().mockResolvedValue({
      values: { legal_name: 'X' },
      setupComplete: true,
      changedFields: ['legal_name'],
    });
    const odoo = { executeKw } as unknown as OdooRpcService;
    const serviceA = new CompanySettingsService(
      fakeContext(tenantAId, accountAId),
      odoo,
      auditService,
      handoffs,
    );
    const serviceB = new CompanySettingsService(
      fakeContext(tenantBId, accountBId),
      odoo,
      auditService,
      handoffs,
    );
    const sharedKey = 'literally-the-same-key';

    await serviceA.updateSettings(fakeReq({ 'idempotency-key': sharedKey }), {
      values: { legal_name: 'X' },
    });
    await serviceB.updateSettings(fakeReq({ 'idempotency-key': sharedKey }), {
      values: { legal_name: 'X' },
    });

    expect(executeKw).toHaveBeenCalledTimes(2);
    expect(await countAuditEvents('company.settings.updated', tenantAId)).toBe(1);
    expect(await countAuditEvents('company.settings.updated', tenantBId)).toBe(1);
  });

  it('absent Idempotency-Key: every call is a distinct new intent, never collapsed, never replayed', async () => {
    const executeKw = jest.fn().mockResolvedValue({
      values: { legal_name: 'Y' },
      setupComplete: true,
      changedFields: ['legal_name'],
    });
    const odoo = { executeKw } as unknown as OdooRpcService;
    const service = new CompanySettingsService(
      fakeContext(tenantAId, accountAId),
      odoo,
      auditService,
      handoffs,
    );
    const body = { values: { legal_name: 'Y' } };

    await service.updateSettings(fakeReq(), body);
    await service.updateSettings(fakeReq(), body);

    expect(executeKw).toHaveBeenCalledTimes(2);
    expect(await countAuditEvents('company.settings.updated', tenantAId)).toBe(2);
  });
});
