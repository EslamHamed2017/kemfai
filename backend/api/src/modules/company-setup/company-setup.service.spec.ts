import { InternalServerErrorException, UnprocessableEntityException } from '@nestjs/common';
import { CompanySetupService } from './company-setup.service';
import { CompanyOdooContextService } from './company-odoo-context.service';
import { AuditService } from '../audit/audit.service';
import {
  CompanyMutationHandoffRow,
  CompanyMutationHandoffService,
} from './company-mutation-handoff.service';
import {
  CompanyMutationAction,
  CompanyMutationHandoffState,
} from './entities/company-mutation-handoff.entity';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';

/**
 * T055 unit coverage of `completeSetup`'s durable-handoff orchestration (arbiter binding
 * resolution): the control-plane handoff is committed BEFORE the Odoo RPC, the audit
 * event is always built from the handoff's own actor/time/operationUuid (never a fresh
 * per-call resolution), and a handoff that is already `audited`/`odoo_committed` short-
 * circuits the work it has already durably done. The real-Odoo proof that
 * `kemfai_setup_complete()` itself re-derives "all required steps submitted" from
 * persisted state, and that its receipt table makes a repeated operation UUID a no-op,
 * lives in `backend/addons/kemfai_company_setup/tests/test_company_setup.py`; this spec
 * stubs the RPC call and the handoff service entirely and asserts only what
 * `CompanySetupService` decides given their results. Real cross-process/crash recovery
 * end-to-end is covered by `test/integration/company-mutation-handoff.integration-spec.ts`.
 */
describe('CompanySetupService.completeSetup (T055, unit)', () => {
  const req = {} as TenantScopedRequest;
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

  function makeService(options: {
    executeKw?: jest.Mock;
    handoff?: CompanyMutationHandoffRow;
    recordCompanySetupCompleted?: jest.Mock;
  }) {
    const executeKw = options.executeKw ?? jest.fn();
    const recordCompanySetupCompleted =
      options.recordCompanySetupCompleted ?? jest.fn().mockResolvedValue(undefined);
    const context = {
      resolve: jest.fn().mockResolvedValue({ db: 'db1', uid: 7, password: 'pw', companyId: 42 }),
      resolveTenantContext: jest.fn().mockResolvedValue({
        keycloakUserId: 'sub-1',
        accountId: 'account-1',
        callerTenantId: 'tenant-1',
      }),
    } as unknown as CompanyOdooContextService;
    const odoo = { executeKw } as unknown as OdooRpcService;
    const audit = { recordCompanySetupCompleted } as unknown as AuditService;
    const findOrCreateCompletionHandoff = jest
      .fn()
      .mockResolvedValue(options.handoff ?? makeHandoff());
    const markOdooCommitted = jest.fn().mockResolvedValue(undefined);
    const markAudited = jest.fn().mockResolvedValue(undefined);
    const deletePending = jest.fn().mockResolvedValue(undefined);
    const scheduleRetryBackoff = jest.fn().mockResolvedValue(undefined);
    const handoffs = {
      findOrCreateCompletionHandoff,
      markOdooCommitted,
      markAudited,
      deletePending,
      scheduleRetryBackoff,
    } as unknown as CompanyMutationHandoffService;
    const service = new CompanySetupService(context, odoo, audit, handoffs);
    return {
      service,
      executeKw,
      recordCompanySetupCompleted,
      findOrCreateCompletionHandoff,
      markOdooCommitted,
      markAudited,
      deletePending,
      scheduleRetryBackoff,
    };
  }

  it('a first-time completion commits the handoff BEFORE the Odoo call, then audits from the handoff identity', async () => {
    const executeKw = jest.fn().mockResolvedValue({
      alreadyComplete: false,
      currentStep: 'accounting_setup',
      setupComplete: true,
      values: { country: 'AE' },
      version: 8,
      stale: false,
    });
    const {
      service,
      findOrCreateCompletionHandoff,
      markOdooCommitted,
      markAudited,
      recordCompanySetupCompleted,
    } = makeService({ executeKw });

    const result = await service.completeSetup(req);

    expect(result).toEqual({
      currentStep: 'accounting_setup',
      setupComplete: true,
      values: { country: 'AE' },
      version: 8,
      stale: false,
    });
    expect(findOrCreateCompletionHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', actorAccountId: 'account-1' }),
    );
    expect(executeKw).toHaveBeenCalledWith('db1', 7, 'pw', 'res.company', 'kemfai_setup_complete', [
      [42],
      'handoff-1',
      occurredAt.toISOString(),
      'account-1',
    ]);
    expect(markOdooCommitted).toHaveBeenCalledWith(
      'handoff-1',
      expect.objectContaining({ setupComplete: true }),
    );
    expect(markAudited).toHaveBeenCalledWith('handoff-1');
    expect(recordCompanySetupCompleted).toHaveBeenCalledWith({
      accountId: 'account-1',
      tenantId: 'tenant-1',
      companyId: 'tenant-1',
      odooDbName: 'db1',
      odooCompanyId: 42,
      occurredAt,
      operationUuid: 'handoff-1',
    });
  });

  it('a handoff already audited short-circuits entirely: no Odoo call, no re-audit', async () => {
    const handoff = makeHandoff({
      state: CompanyMutationHandoffState.AUDITED,
      finalResponse: {
        currentStep: 'accounting_setup',
        setupComplete: true,
        values: { country: 'AE' },
        version: 8,
        stale: false,
      },
    });
    const { service, executeKw, recordCompanySetupCompleted } = makeService({ handoff });

    const result = await service.completeSetup(req);

    expect(result.setupComplete).toBe(true);
    expect(executeKw).not.toHaveBeenCalled();
    expect(recordCompanySetupCompleted).not.toHaveBeenCalled();
  });

  it('a handoff already odoo_committed (recovered by a retry/worker race) skips the RPC and appends the audit from the handoff', async () => {
    const handoff = makeHandoff({
      state: CompanyMutationHandoffState.ODOO_COMMITTED,
      finalResponse: {
        alreadyComplete: false,
        currentStep: 'accounting_setup',
        setupComplete: true,
        values: { country: 'AE' },
        version: 8,
        stale: false,
      },
    });
    const { service, executeKw, recordCompanySetupCompleted, markAudited } = makeService({
      handoff,
    });

    const result = await service.completeSetup(req);

    expect(result.setupComplete).toBe(true);
    expect(executeKw).not.toHaveBeenCalled();
    expect(recordCompanySetupCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ operationUuid: 'handoff-1', occurredAt }),
    );
    expect(markAudited).toHaveBeenCalledWith('handoff-1');
  });

  it('propagates the addon KEMFAI_SETUP_INCOMPLETE error as 422, releases the pending handoff, never audits', async () => {
    const executeKw = jest
      .fn()
      .mockRejectedValue(
        new Error('KEMFAI_SETUP_INCOMPLETE: required step(s) not yet submitted: vat_tax'),
      );
    const { service, deletePending, recordCompanySetupCompleted } = makeService({ executeKw });

    await expect(service.completeSetup(req)).rejects.toThrow(UnprocessableEntityException);
    expect(deletePending).toHaveBeenCalledWith('handoff-1');
    expect(recordCompanySetupCompleted).not.toHaveBeenCalled();
  });

  it('B1: an ambiguous RPC failure (not a typed KEMFAI_ fault) never deletes the handoff — it is left retryable and the caller gets a typed 5xx', async () => {
    const executeKw = jest.fn().mockRejectedValue(new Error('ECONNRESET: socket hang up'));
    const { service, deletePending, scheduleRetryBackoff, recordCompanySetupCompleted } =
      makeService({ executeKw });

    await expect(service.completeSetup(req)).rejects.toThrow(InternalServerErrorException);
    expect(deletePending).not.toHaveBeenCalled();
    expect(scheduleRetryBackoff).toHaveBeenCalledWith('handoff-1', expect.any(Number));
    expect(recordCompanySetupCompleted).not.toHaveBeenCalled();
  });

  it('refuses to create a handoff or audit without a resolved account/tenant', async () => {
    const context = {
      resolve: jest.fn().mockResolvedValue({ db: 'db1', uid: 7, password: 'pw', companyId: 42 }),
      resolveTenantContext: jest.fn().mockResolvedValue({
        keycloakUserId: 'sub-1',
        accountId: null,
        callerTenantId: 'tenant-1',
      }),
    } as unknown as CompanyOdooContextService;
    const odoo = { executeKw: jest.fn() } as unknown as OdooRpcService;
    const audit = { recordCompanySetupCompleted: jest.fn() } as unknown as AuditService;
    const findOrCreateCompletionHandoff = jest.fn();
    const handoffs = { findOrCreateCompletionHandoff } as unknown as CompanyMutationHandoffService;
    const service = new CompanySetupService(context, odoo, audit, handoffs);

    await expect(service.completeSetup(req)).rejects.toThrow(InternalServerErrorException);
    expect(findOrCreateCompletionHandoff).not.toHaveBeenCalled();
  });
});
