import { CompanyMutationRecoveryWorker } from './company-mutation-recovery.worker';
import {
  CompanyMutationHandoffRow,
  CompanyMutationHandoffService,
} from './company-mutation-handoff.service';
import { CompanyOdooContextService } from './company-odoo-context.service';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { AuditService } from '../audit/audit.service';
import {
  CompanyMutationAction,
  CompanyMutationHandoffState,
} from './entities/company-mutation-handoff.entity';

/**
 * T055 arbiter binding resolution, point 4 — unit coverage of the worker's own recovery
 * decision logic (which action to replay, which state transition to skip, how a failure
 * backs off) with every collaborator mocked. The real cross-process guarantee — that
 * this worker is actually registered in the production module graph and genuinely
 * recovers a handoff another process left behind, without any further HTTP request —
 * is proven against real Postgres/Odoo in
 * `test/integration/company-mutation-handoff.integration-spec.ts`; mocks here can only
 * supplement that, never substitute for it.
 */
describe('CompanyMutationRecoveryWorker (T055, unit)', () => {
  const occurredAt = new Date('2026-10-05T00:00:00.000Z');

  function makeHandoff(
    overrides: Partial<CompanyMutationHandoffRow> = {},
  ): CompanyMutationHandoffRow {
    return {
      id: 'handoff-1',
      action: CompanyMutationAction.SETUP_COMPLETE,
      tenantId: 'tenant-1',
      actorAccountId: 'account-1',
      principalIdentity: 'sub-1',
      odooDbName: 'db1',
      odooCompanyId: 42,
      requestFingerprint: 'setup.complete',
      requestPayload: {},
      occurredAt,
      idempotencyKey: null,
      callerScope: null,
      method: null,
      route: null,
      state: CompanyMutationHandoffState.PENDING,
      retryCount: 0,
      finalResponse: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      ...overrides,
    };
  }

  function makeWorker(batch: CompanyMutationHandoffRow[]) {
    const claimBatchForRecovery = jest.fn().mockResolvedValue(batch);
    const markOdooCommitted = jest.fn().mockResolvedValue(undefined);
    const markAudited = jest.fn().mockResolvedValue(undefined);
    const scheduleRetryBackoff = jest.fn().mockResolvedValue(undefined);
    const handoffs = {
      claimBatchForRecovery,
      markOdooCommitted,
      markAudited,
      scheduleRetryBackoff,
    } as unknown as CompanyMutationHandoffService;

    const resolveByTenantId = jest
      .fn()
      .mockResolvedValue({ db: 'db1', uid: 7, password: 'pw', companyId: 42 });
    const context = { resolveByTenantId } as unknown as CompanyOdooContextService;

    const executeKw = jest.fn();
    const odoo = { executeKw } as unknown as OdooRpcService;

    const recordCompanySetupCompleted = jest.fn().mockResolvedValue(undefined);
    const recordCompanySettingsUpdated = jest.fn().mockResolvedValue(undefined);
    const audit = {
      recordCompanySetupCompleted,
      recordCompanySettingsUpdated,
    } as unknown as AuditService;

    const worker = new CompanyMutationRecoveryWorker(handoffs, context, odoo, audit);
    return {
      worker,
      claimBatchForRecovery,
      markOdooCommitted,
      markAudited,
      scheduleRetryBackoff,
      executeKw,
      recordCompanySetupCompleted,
      recordCompanySettingsUpdated,
    };
  }

  const validCompletionResult = {
    currentStep: 'accounting_setup',
    setupComplete: true,
    alreadyComplete: false,
    values: { country: 'AE' },
    version: 8,
    stale: false,
  };

  it('a pending setup.complete handoff is replayed against Odoo, then committed and audited', async () => {
    const handoff = makeHandoff();
    const { worker, executeKw, markOdooCommitted, markAudited, recordCompanySetupCompleted } =
      makeWorker([handoff]);
    executeKw.mockResolvedValue(validCompletionResult);

    await worker.tick();

    expect(executeKw).toHaveBeenCalledWith('db1', 7, 'pw', 'res.company', 'kemfai_setup_complete', [
      [42],
      'handoff-1',
      occurredAt.toISOString(),
      'account-1',
    ]);
    expect(markOdooCommitted).toHaveBeenCalledWith('handoff-1', validCompletionResult);
    expect(recordCompanySetupCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ operationUuid: 'handoff-1', occurredAt }),
    );
    expect(markAudited).toHaveBeenCalledWith('handoff-1');
  });

  it('round-3 point 2: a malformed FRESH replayed setup.complete result is never committed/audited — left retryable', async () => {
    const handoff = makeHandoff();
    const {
      worker,
      executeKw,
      markOdooCommitted,
      markAudited,
      recordCompanySetupCompleted,
      scheduleRetryBackoff,
    } = makeWorker([handoff]);
    executeKw.mockResolvedValue({ ...validCompletionResult, currentStep: 'not_a_real_step' });

    await worker.tick();

    expect(markOdooCommitted).not.toHaveBeenCalled();
    expect(markAudited).not.toHaveBeenCalled();
    expect(recordCompanySetupCompleted).not.toHaveBeenCalled();
    expect(scheduleRetryBackoff).toHaveBeenCalledWith('handoff-1', expect.any(Number));
  });

  it('round-3 point 2: a malformed STORED odoo_committed setup.complete payload is never audited/marked audited — left retryable', async () => {
    const handoff = makeHandoff({
      state: CompanyMutationHandoffState.ODOO_COMMITTED,
      finalResponse: { ...validCompletionResult, version: -5 },
    });
    const { worker, executeKw, markAudited, recordCompanySetupCompleted, scheduleRetryBackoff } =
      makeWorker([handoff]);

    await worker.tick();

    expect(executeKw).not.toHaveBeenCalled();
    expect(markAudited).not.toHaveBeenCalled();
    expect(recordCompanySetupCompleted).not.toHaveBeenCalled();
    expect(scheduleRetryBackoff).toHaveBeenCalledWith('handoff-1', expect.any(Number));
  });

  it('an odoo_committed settings.update handoff skips the RPC and audits directly from the stored finalResponse', async () => {
    const handoff = makeHandoff({
      action: CompanyMutationAction.SETTINGS_UPDATE,
      state: CompanyMutationHandoffState.ODOO_COMMITTED,
      finalResponse: {
        values: { legal_name: 'After' },
        setupComplete: true,
        changedFields: ['legal_name'],
      },
    });
    const { worker, executeKw, markOdooCommitted, markAudited, recordCompanySettingsUpdated } =
      makeWorker([handoff]);

    await worker.tick();

    expect(executeKw).not.toHaveBeenCalled();
    expect(markOdooCommitted).not.toHaveBeenCalled();
    expect(recordCompanySettingsUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        operationUuid: 'handoff-1',
        changedFields: ['legal_name'],
        occurredAt,
      }),
    );
    expect(markAudited).toHaveBeenCalledWith('handoff-1');
  });

  it('a pending settings.update handoff replays the Odoo RPC with its own stored requestPayload', async () => {
    const handoff = makeHandoff({
      action: CompanyMutationAction.SETTINGS_UPDATE,
      requestPayload: { legal_name: 'Acme Holdings' },
    });
    const { worker, executeKw } = makeWorker([handoff]);
    executeKw.mockResolvedValue({ values: {}, setupComplete: true, changedFields: ['legal_name'] });

    await worker.tick();

    expect(executeKw).toHaveBeenCalledWith(
      'db1',
      7,
      'pw',
      'res.company',
      'kemfai_settings_update',
      [[42], { legal_name: 'Acme Holdings' }, 'handoff-1', occurredAt.toISOString(), 'account-1'],
    );
  });

  it('a failed recovery attempt backs off instead of marking audited', async () => {
    const handoff = makeHandoff();
    const { worker, executeKw, markAudited, scheduleRetryBackoff } = makeWorker([handoff]);
    executeKw.mockRejectedValue(new Error('odoo unreachable'));

    await worker.tick();

    expect(markAudited).not.toHaveBeenCalled();
    expect(scheduleRetryBackoff).toHaveBeenCalledWith('handoff-1', expect.any(Number));
  });

  it("B3: a resolved Odoo target that no longer matches the handoff's stored db/company is never dispatched — it backs off instead", async () => {
    const handoff = makeHandoff({ odooDbName: 'db1', odooCompanyId: 42 });
    const claimBatchForRecovery = jest.fn().mockResolvedValue([handoff]);
    const markOdooCommitted = jest.fn().mockResolvedValue(undefined);
    const markAudited = jest.fn().mockResolvedValue(undefined);
    const scheduleRetryBackoff = jest.fn().mockResolvedValue(undefined);
    const handoffs = {
      claimBatchForRecovery,
      markOdooCommitted,
      markAudited,
      scheduleRetryBackoff,
    } as unknown as CompanyMutationHandoffService;

    // Resolves to a DIFFERENT database/company than the handoff's immutable stored
    // target — simulating tenant provisioning metadata that changed between the
    // original request and recovery.
    const resolveByTenantId = jest
      .fn()
      .mockResolvedValue({ db: 'a-different-db', uid: 7, password: 'pw', companyId: 999 });
    const context = { resolveByTenantId } as unknown as CompanyOdooContextService;
    const executeKw = jest.fn();
    const odoo = { executeKw } as unknown as OdooRpcService;
    const audit = {
      recordCompanySetupCompleted: jest.fn(),
      recordCompanySettingsUpdated: jest.fn(),
    } as unknown as AuditService;

    const worker = new CompanyMutationRecoveryWorker(handoffs, context, odoo, audit);
    await worker.tick();

    expect(executeKw).not.toHaveBeenCalled();
    expect(markOdooCommitted).not.toHaveBeenCalled();
    expect(markAudited).not.toHaveBeenCalled();
    expect(scheduleRetryBackoff).toHaveBeenCalledWith('handoff-1', expect.any(Number));
  });

  it('overlapping ticks do not run concurrently', async () => {
    let resolveClaim: (() => void) | undefined;
    const claimBatchForRecovery = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveClaim = () => resolve([]);
        }),
    );
    const handoffs = {
      claimBatchForRecovery,
      markOdooCommitted: jest.fn(),
      markAudited: jest.fn(),
      scheduleRetryBackoff: jest.fn(),
    } as unknown as CompanyMutationHandoffService;
    const worker = new CompanyMutationRecoveryWorker(
      handoffs,
      {} as CompanyOdooContextService,
      {} as OdooRpcService,
      {} as AuditService,
    );

    const first = worker.tick();
    const second = worker.tick();
    expect(claimBatchForRecovery).toHaveBeenCalledTimes(1);
    resolveClaim?.();
    await Promise.all([first, second]);
  });
});
