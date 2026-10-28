import {
  InternalServerErrorException,
  PreconditionFailedException,
  UnprocessableEntityException,
} from '@nestjs/common';
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
import { computeCompanySetupScope } from './company-setup-scope.util';
import controlDataSource from '../../database/data-source';
import { Tenant } from '../tenants/entities/tenant.entity';
import { TenantContextResolver } from '../../common/tenant-context/tenant-context.resolver';

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
  // T056 round 3 — scope is REQUIRED on every completion call now; every case in this
  // T055 describe block uses the same account-1/tenant-1/companyId-42 context below, so
  // this is the one matching scope they all echo.
  const VALID_SCOPE = computeCompanySetupScope('tenant-1', 'account-1', 42);

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
      resolveTenantContext: jest.fn().mockResolvedValue({
        keycloakUserId: 'sub-1',
        accountId: 'account-1',
        callerTenantId: 'tenant-1',
      }),
      resolveCompanyTarget: jest.fn().mockResolvedValue(42),
      resolveCredentials: jest.fn().mockResolvedValue({ db: 'db1', uid: 7, password: 'pw' }),
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

    const result = await service.completeSetup(req, VALID_SCOPE);

    expect(result).toEqual({
      currentStep: 'accounting_setup',
      setupComplete: true,
      values: { country: 'AE' },
      version: 8,
      stale: false,
      scope: computeCompanySetupScope('tenant-1', 'account-1', 42),
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
        alreadyComplete: false,
        currentStep: 'accounting_setup',
        setupComplete: true,
        values: { country: 'AE' },
        version: 8,
        stale: false,
      },
    });
    const { service, executeKw, recordCompanySetupCompleted } = makeService({ handoff });

    const result = await service.completeSetup(req, VALID_SCOPE);

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

    const result = await service.completeSetup(req, VALID_SCOPE);

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

    await expect(service.completeSetup(req, VALID_SCOPE)).rejects.toThrow(
      UnprocessableEntityException,
    );
    expect(deletePending).toHaveBeenCalledWith('handoff-1');
    expect(recordCompanySetupCompleted).not.toHaveBeenCalled();
  });

  it('B1: an ambiguous RPC failure (not a typed KEMFAI_ fault) never deletes the handoff — it is left retryable and the caller gets a typed 5xx', async () => {
    const executeKw = jest.fn().mockRejectedValue(new Error('ECONNRESET: socket hang up'));
    const { service, deletePending, scheduleRetryBackoff, recordCompanySetupCompleted } =
      makeService({ executeKw });

    await expect(service.completeSetup(req, VALID_SCOPE)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(deletePending).not.toHaveBeenCalled();
    expect(scheduleRetryBackoff).toHaveBeenCalledWith('handoff-1', expect.any(Number));
    expect(recordCompanySetupCompleted).not.toHaveBeenCalled();
  });

  it('round-3 point 2: a malformed FRESH Odoo completion result (bad currentStep) never reaches markOdooCommitted/audit/markAudited — handoff left retryable, caller gets 5xx', async () => {
    const executeKw = jest.fn().mockResolvedValue({
      alreadyComplete: false,
      currentStep: 'not_a_real_step',
      setupComplete: true,
      values: { country: 'AE' },
      version: 8,
      stale: false,
    });
    const {
      service,
      markOdooCommitted,
      markAudited,
      recordCompanySetupCompleted,
      scheduleRetryBackoff,
      deletePending,
    } = makeService({ executeKw });

    await expect(service.completeSetup(req, VALID_SCOPE)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(markOdooCommitted).not.toHaveBeenCalled();
    expect(markAudited).not.toHaveBeenCalled();
    expect(recordCompanySetupCompleted).not.toHaveBeenCalled();
    expect(deletePending).not.toHaveBeenCalled();
    expect(scheduleRetryBackoff).toHaveBeenCalledWith('handoff-1', expect.any(Number));
  });

  it('round-3 point 2: a malformed FRESH Odoo completion result missing alreadyComplete never reaches markOdooCommitted/audit/markAudited', async () => {
    const executeKw = jest.fn().mockResolvedValue({
      // alreadyComplete deliberately omitted
      currentStep: 'accounting_setup',
      setupComplete: true,
      values: { country: 'AE' },
      version: 8,
      stale: false,
    });
    const { service, markOdooCommitted, markAudited, recordCompanySetupCompleted } = makeService({
      executeKw,
    });

    await expect(service.completeSetup(req, VALID_SCOPE)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(markOdooCommitted).not.toHaveBeenCalled();
    expect(markAudited).not.toHaveBeenCalled();
    expect(recordCompanySetupCompleted).not.toHaveBeenCalled();
  });

  it('round-3 point 2: a malformed STORED odoo_committed payload (negative version) never reaches audit/markAudited', async () => {
    const handoff = makeHandoff({
      state: CompanyMutationHandoffState.ODOO_COMMITTED,
      finalResponse: {
        alreadyComplete: false,
        currentStep: 'accounting_setup',
        setupComplete: true,
        values: { country: 'AE' },
        version: -1,
        stale: false,
      },
    });
    const { service, executeKw, markAudited, recordCompanySetupCompleted } = makeService({
      handoff,
    });

    await expect(service.completeSetup(req, VALID_SCOPE)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(executeKw).not.toHaveBeenCalled();
    expect(markAudited).not.toHaveBeenCalled();
    expect(recordCompanySetupCompleted).not.toHaveBeenCalled();
  });

  it('round-3 point 2: a malformed STORED audited payload (non-boolean setupComplete) never reaches toDto successfully — 5xx, not a malformed 200', async () => {
    const handoff = makeHandoff({
      state: CompanyMutationHandoffState.AUDITED,
      finalResponse: {
        alreadyComplete: true,
        currentStep: 'accounting_setup',
        setupComplete: 'yes' as unknown as boolean,
        values: { country: 'AE' },
        version: 8,
        stale: false,
      },
    });
    const { service, executeKw, recordCompanySetupCompleted } = makeService({ handoff });

    await expect(service.completeSetup(req, VALID_SCOPE)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(executeKw).not.toHaveBeenCalled();
    expect(recordCompanySetupCompleted).not.toHaveBeenCalled();
  });

  it('refuses to create a handoff or audit without a resolved account/tenant, with zero Odoo calls', async () => {
    const resolveCompanyTarget = jest.fn().mockResolvedValue(42);
    const resolveCredentials = jest.fn().mockResolvedValue({ db: 'db1', uid: 7, password: 'pw' });
    const context = {
      resolveTenantContext: jest.fn().mockResolvedValue({
        keycloakUserId: 'sub-1',
        accountId: null,
        callerTenantId: 'tenant-1',
      }),
      resolveCompanyTarget,
      resolveCredentials,
    } as unknown as CompanyOdooContextService;
    const odoo = { executeKw: jest.fn() } as unknown as OdooRpcService;
    const audit = { recordCompanySetupCompleted: jest.fn() } as unknown as AuditService;
    const findOrCreateCompletionHandoff = jest.fn();
    const handoffs = { findOrCreateCompletionHandoff } as unknown as CompanyMutationHandoffService;
    const service = new CompanySetupService(context, odoo, audit, handoffs);

    await expect(service.completeSetup(req, VALID_SCOPE)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(findOrCreateCompletionHandoff).not.toHaveBeenCalled();
    // T056 round-5 (item 2) — an incomplete principal must fail BEFORE the control-plane
    // company-target lookup and BEFORE Odoo credential resolution, not merely before the
    // completion handoff.
    expect(resolveCompanyTarget).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
  });
});

/**
 * T056 binding-review point 2 — `getState`/`saveStep` must fail closed on an unresolved
 * tenant/account exactly like `completeSetup` already did; a token that resolves without
 * one must never reach the Odoo RPC or have `toDto` hash a missing identity component
 * into a false opaque scope.
 */
describe('CompanySetupService.getState / saveStep (T056, unit)', () => {
  const req = {} as TenantScopedRequest;

  function makeServiceWithTenantContext(tenantContext: {
    keycloakUserId: string;
    accountId: string | null;
    callerTenantId: string | null;
  }) {
    const executeKw = jest.fn().mockResolvedValue({
      currentStep: 'country',
      setupComplete: false,
      values: {},
      version: 1,
      stale: false,
    });
    const resolveCompanyTarget = jest.fn().mockResolvedValue(42);
    const resolveCredentials = jest.fn().mockResolvedValue({ db: 'db1', uid: 7, password: 'pw' });
    const context = {
      resolveTenantContext: jest.fn().mockResolvedValue(tenantContext),
      resolveCompanyTarget,
      resolveCredentials,
    } as unknown as CompanyOdooContextService;
    const odoo = { executeKw } as unknown as OdooRpcService;
    const audit = {} as unknown as AuditService;
    const handoffs = {} as unknown as CompanyMutationHandoffService;
    const service = new CompanySetupService(context, odoo, audit, handoffs);
    return { service, executeKw, resolveCompanyTarget, resolveCredentials };
  }

  it('getState fails closed with a missing accountId, before the company-target lookup or Odoo credentials', async () => {
    const { service, executeKw, resolveCompanyTarget, resolveCredentials } =
      makeServiceWithTenantContext({
        keycloakUserId: 'sub-1',
        accountId: null,
        callerTenantId: 'tenant-1',
      });
    await expect(service.getState(req)).rejects.toThrow(InternalServerErrorException);
    expect(executeKw).not.toHaveBeenCalled();
    expect(resolveCompanyTarget).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
  });

  it('getState fails closed with a missing callerTenantId', async () => {
    const { service, executeKw, resolveCompanyTarget, resolveCredentials } =
      makeServiceWithTenantContext({
        keycloakUserId: 'sub-1',
        accountId: 'account-1',
        callerTenantId: null,
      });
    await expect(service.getState(req)).rejects.toThrow(InternalServerErrorException);
    expect(executeKw).not.toHaveBeenCalled();
    expect(resolveCompanyTarget).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
  });

  it.each(['', '   '])(
    'getState fails closed with a %p (empty/whitespace) keycloakUserId',
    async (bad) => {
      const { service, executeKw, resolveCompanyTarget, resolveCredentials } =
        makeServiceWithTenantContext({
          keycloakUserId: bad,
          accountId: 'account-1',
          callerTenantId: 'tenant-1',
        });
      await expect(service.getState(req)).rejects.toThrow(InternalServerErrorException);
      expect(executeKw).not.toHaveBeenCalled();
      expect(resolveCompanyTarget).not.toHaveBeenCalled();
      expect(resolveCredentials).not.toHaveBeenCalled();
    },
  );

  it('saveStep fails closed with a missing accountId, before the company-target lookup or Odoo credentials', async () => {
    const { service, executeKw, resolveCompanyTarget, resolveCredentials } =
      makeServiceWithTenantContext({
        keycloakUserId: 'sub-1',
        accountId: null,
        callerTenantId: 'tenant-1',
      });
    await expect(service.saveStep(req, { step: 'country', values: {} } as never)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(executeKw).not.toHaveBeenCalled();
    expect(resolveCompanyTarget).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
  });

  it.each(['', '   '])(
    'saveStep fails closed with a %p (empty/whitespace) keycloakUserId',
    async (bad) => {
      const { service, executeKw, resolveCompanyTarget, resolveCredentials } =
        makeServiceWithTenantContext({
          keycloakUserId: bad,
          accountId: 'account-1',
          callerTenantId: 'tenant-1',
        });
      await expect(
        service.saveStep(req, { step: 'country', values: {} } as never, 'any'),
      ).rejects.toThrow(InternalServerErrorException);
      expect(executeKw).not.toHaveBeenCalled();
      expect(resolveCompanyTarget).not.toHaveBeenCalled();
      expect(resolveCredentials).not.toHaveBeenCalled();
    },
  );

  it('getState returns a scope hashed from the real resolved tenant/account when both are present', async () => {
    const { service } = makeServiceWithTenantContext({
      keycloakUserId: 'sub-1',
      accountId: 'account-1',
      callerTenantId: 'tenant-1',
    });
    const result = await service.getState(req);
    expect(result.scope).toBe(computeCompanySetupScope('tenant-1', 'account-1', 42));
  });

  it('saveStep fails closed with a whitespace-only accountId (not a real identity)', async () => {
    const { service, executeKw, resolveCompanyTarget, resolveCredentials } =
      makeServiceWithTenantContext({
        keycloakUserId: 'sub-1',
        accountId: '   ',
        callerTenantId: 'tenant-1',
      });
    await expect(service.saveStep(req, { step: 'country', values: {} } as never)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(executeKw).not.toHaveBeenCalled();
    expect(resolveCompanyTarget).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
  });

  it('getState fails closed with a whitespace-only callerTenantId', async () => {
    const { service, executeKw, resolveCompanyTarget, resolveCredentials } =
      makeServiceWithTenantContext({
        keycloakUserId: 'sub-1',
        accountId: 'account-1',
        callerTenantId: '   ',
      });
    await expect(service.getState(req)).rejects.toThrow(InternalServerErrorException);
    expect(executeKw).not.toHaveBeenCalled();
    expect(resolveCompanyTarget).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
  });
});

/**
 * T056 binding-review point 1 — the server, not just the client, must enforce the
 * X-KEMFAI-Setup-Scope precondition BEFORE any Odoo mutation: a stale scope from a
 * session/account transition must never reach `kemfai_setup_save_step`/
 * `kemfai_setup_complete`.
 */
describe('CompanySetupService scope precondition (T056, unit)', () => {
  const req = {} as TenantScopedRequest;

  function makeServiceForScope() {
    const executeKw = jest.fn().mockResolvedValue({
      currentStep: 'identity',
      setupComplete: false,
      values: {},
      version: 2,
      stale: false,
    });
    const resolveCompanyTarget = jest.fn().mockResolvedValue(42);
    const resolveCredentials = jest.fn().mockResolvedValue({ db: 'db1', uid: 7, password: 'pw' });
    const context = {
      resolveTenantContext: jest.fn().mockResolvedValue({
        keycloakUserId: 'sub-1',
        accountId: 'beta-account',
        callerTenantId: 'beta-tenant',
      }),
      resolveCompanyTarget,
      resolveCredentials,
    } as unknown as CompanyOdooContextService;
    const odoo = { executeKw } as unknown as OdooRpcService;
    const audit = { recordCompanySetupCompleted: jest.fn() } as unknown as AuditService;
    const findOrCreateCompletionHandoff = jest.fn();
    const handoffs = { findOrCreateCompletionHandoff } as unknown as CompanyMutationHandoffService;
    const service = new CompanySetupService(context, odoo, audit, handoffs);
    return {
      service,
      executeKw,
      findOrCreateCompletionHandoff,
      resolveCompanyTarget,
      resolveCredentials,
    };
  }

  it('saveStep rejects a stale (Alpha) scope with 412 BEFORE any Odoo RPC (authenticate OR mutation) for the now-authenticated Beta company', async () => {
    const { service, executeKw, resolveCredentials } = makeServiceForScope();
    const staleAlphaScope = computeCompanySetupScope('alpha-tenant', 'alpha-account', 42);

    await expect(
      service.saveStep(req, { step: 'country', values: {} } as never, staleAlphaScope),
    ).rejects.toThrow(PreconditionFailedException);
    expect(executeKw).not.toHaveBeenCalled();
    // T056 round-5 (item 1) — `resolveCredentials` is the ONLY point allowed to call
    // `odoo.authenticate`; a stale scope must never reach it.
    expect(resolveCredentials).not.toHaveBeenCalled();
  });

  it('saveStep accepts a scope that matches the authenticated tenant/account/company, and only authenticates AFTER the scope check passes', async () => {
    const { service, executeKw, resolveCredentials } = makeServiceForScope();
    const matchingScope = computeCompanySetupScope('beta-tenant', 'beta-account', 42);

    await expect(
      service.saveStep(req, { step: 'country', values: {} } as never, matchingScope),
    ).resolves.toMatchObject({ currentStep: 'identity' });
    expect(executeKw).toHaveBeenCalled();
    expect(resolveCredentials).toHaveBeenCalledWith('beta-tenant');
  });

  it('saveStep REJECTS a missing scope header with 412 BEFORE any Odoo RPC — no first-save exception', async () => {
    const { service, executeKw, resolveCredentials } = makeServiceForScope();

    await expect(
      service.saveStep(req, { step: 'country', values: {} } as never, undefined),
    ).rejects.toThrow(PreconditionFailedException);
    expect(executeKw).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
  });

  it('saveStep REJECTS a blank/whitespace-only scope header with 412 BEFORE any Odoo RPC', async () => {
    const { service, executeKw, resolveCredentials } = makeServiceForScope();

    await expect(
      service.saveStep(req, { step: 'country', values: {} } as never, '   '),
    ).rejects.toThrow(PreconditionFailedException);
    expect(executeKw).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
  });

  it('completeSetup rejects a stale scope with 412 BEFORE the completion handoff is created or any Odoo RPC', async () => {
    const { service, findOrCreateCompletionHandoff, resolveCredentials } = makeServiceForScope();
    const staleAlphaScope = computeCompanySetupScope('alpha-tenant', 'alpha-account', 42);

    await expect(service.completeSetup(req, staleAlphaScope)).rejects.toThrow(
      PreconditionFailedException,
    );
    expect(findOrCreateCompletionHandoff).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
  });

  it('completeSetup REJECTS a missing scope header with 412 BEFORE the completion handoff is created — no first-save exception', async () => {
    const { service, findOrCreateCompletionHandoff, resolveCredentials } = makeServiceForScope();

    await expect(service.completeSetup(req, undefined)).rejects.toThrow(
      PreconditionFailedException,
    );
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(findOrCreateCompletionHandoff).not.toHaveBeenCalled();
  });
});

/**
 * T056 round-3 binding resolution point 6 — the full empty/whitespace principal-identity
 * matrix: `accountId`, `callerTenantId` (both GET/PUT already covered above) and,
 * specifically for completion, `keycloakUserId` — every one of these, empty OR
 * whitespace-only, must fail closed before any Odoo RPC or handoff creation.
 */
describe('CompanySetupService principal-identity matrix (T056, unit)', () => {
  const req = {} as TenantScopedRequest;

  function makeServiceWithTenantContext(tenantContext: {
    keycloakUserId: string;
    accountId: string | null;
    callerTenantId: string | null;
  }) {
    const executeKw = jest.fn().mockResolvedValue({
      currentStep: 'country',
      setupComplete: false,
      values: {},
      version: 1,
      stale: false,
    });
    const resolveCompanyTarget = jest.fn().mockResolvedValue(42);
    const resolveCredentials = jest.fn().mockResolvedValue({ db: 'db1', uid: 7, password: 'pw' });
    const context = {
      resolveTenantContext: jest.fn().mockResolvedValue(tenantContext),
      resolveCompanyTarget,
      resolveCredentials,
    } as unknown as CompanyOdooContextService;
    const odoo = { executeKw } as unknown as OdooRpcService;
    const audit = { recordCompanySetupCompleted: jest.fn() } as unknown as AuditService;
    const findOrCreateCompletionHandoff = jest.fn();
    const handoffs = { findOrCreateCompletionHandoff } as unknown as CompanyMutationHandoffService;
    const service = new CompanySetupService(context, odoo, audit, handoffs);
    return {
      service,
      executeKw,
      findOrCreateCompletionHandoff,
      resolveCompanyTarget,
      resolveCredentials,
    };
  }

  it.each(['', '   '])(
    'getState fails closed with accountId %p (empty/whitespace), before company-target lookup or Odoo credentials',
    async (bad) => {
      const { service, executeKw, resolveCompanyTarget, resolveCredentials } =
        makeServiceWithTenantContext({
          keycloakUserId: 'sub-1',
          accountId: bad,
          callerTenantId: 'tenant-1',
        });
      await expect(service.getState(req)).rejects.toThrow(InternalServerErrorException);
      expect(executeKw).not.toHaveBeenCalled();
      expect(resolveCompanyTarget).not.toHaveBeenCalled();
      expect(resolveCredentials).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   '])(
    'getState fails closed with callerTenantId %p (empty/whitespace)',
    async (bad) => {
      const { service, executeKw, resolveCompanyTarget, resolveCredentials } =
        makeServiceWithTenantContext({
          keycloakUserId: 'sub-1',
          accountId: 'account-1',
          callerTenantId: bad,
        });
      await expect(service.getState(req)).rejects.toThrow(InternalServerErrorException);
      expect(executeKw).not.toHaveBeenCalled();
      expect(resolveCompanyTarget).not.toHaveBeenCalled();
      expect(resolveCredentials).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   '])(
    'saveStep fails closed with accountId %p (empty/whitespace), before company-target lookup or Odoo credentials',
    async (bad) => {
      const { service, executeKw, resolveCompanyTarget, resolveCredentials } =
        makeServiceWithTenantContext({
          keycloakUserId: 'sub-1',
          accountId: bad,
          callerTenantId: 'tenant-1',
        });
      await expect(
        service.saveStep(req, { step: 'country', values: {} } as never, 'any'),
      ).rejects.toThrow(InternalServerErrorException);
      expect(executeKw).not.toHaveBeenCalled();
      expect(resolveCompanyTarget).not.toHaveBeenCalled();
      expect(resolveCredentials).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   '])(
    'saveStep fails closed with callerTenantId %p (empty/whitespace), before company-target lookup or Odoo credentials',
    async (bad) => {
      const { service, executeKw, resolveCompanyTarget, resolveCredentials } =
        makeServiceWithTenantContext({
          keycloakUserId: 'sub-1',
          accountId: 'account-1',
          callerTenantId: bad,
        });
      await expect(
        service.saveStep(req, { step: 'country', values: {} } as never, 'any'),
      ).rejects.toThrow(InternalServerErrorException);
      expect(executeKw).not.toHaveBeenCalled();
      expect(resolveCompanyTarget).not.toHaveBeenCalled();
      expect(resolveCredentials).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   '])(
    'completeSetup fails closed with keycloakUserId %p (empty/whitespace): no company-target lookup, no Odoo credentials, no handoff',
    async (bad) => {
      const {
        service,
        executeKw,
        findOrCreateCompletionHandoff,
        resolveCompanyTarget,
        resolveCredentials,
      } = makeServiceWithTenantContext({
        keycloakUserId: bad,
        accountId: 'account-1',
        callerTenantId: 'tenant-1',
      });
      const matchingScope = computeCompanySetupScope('tenant-1', 'account-1', 42);
      await expect(service.completeSetup(req, matchingScope)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(executeKw).not.toHaveBeenCalled();
      expect(resolveCompanyTarget).not.toHaveBeenCalled();
      expect(resolveCredentials).not.toHaveBeenCalled();
      expect(findOrCreateCompletionHandoff).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   '])(
    'completeSetup fails closed with accountId %p (empty/whitespace): no company-target lookup, no Odoo credentials, no handoff',
    async (bad) => {
      const {
        service,
        executeKw,
        findOrCreateCompletionHandoff,
        resolveCompanyTarget,
        resolveCredentials,
      } = makeServiceWithTenantContext({
        keycloakUserId: 'sub-1',
        accountId: bad,
        callerTenantId: 'tenant-1',
      });
      await expect(service.completeSetup(req, 'any')).rejects.toThrow(InternalServerErrorException);
      expect(executeKw).not.toHaveBeenCalled();
      expect(resolveCompanyTarget).not.toHaveBeenCalled();
      expect(resolveCredentials).not.toHaveBeenCalled();
      expect(findOrCreateCompletionHandoff).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   '])(
    'completeSetup fails closed with callerTenantId %p (empty/whitespace): no company-target lookup, no Odoo credentials, no handoff',
    async (bad) => {
      const {
        service,
        executeKw,
        findOrCreateCompletionHandoff,
        resolveCompanyTarget,
        resolveCredentials,
      } = makeServiceWithTenantContext({
        keycloakUserId: 'sub-1',
        accountId: 'account-1',
        callerTenantId: bad,
      });
      await expect(service.completeSetup(req, 'any')).rejects.toThrow(InternalServerErrorException);
      expect(executeKw).not.toHaveBeenCalled();
      expect(resolveCompanyTarget).not.toHaveBeenCalled();
      expect(resolveCredentials).not.toHaveBeenCalled();
      expect(findOrCreateCompletionHandoff).not.toHaveBeenCalled();
    },
  );
});

/**
 * T056 binding-review point 5 — `toDto` must validate the Odoo/handoff-sourced result
 * before trusting it: a malformed upstream shape becomes a generic 5xx, never a
 * malformed 200 handed to the client.
 */
describe('CompanySetupService upstream-state validation (T056, unit)', () => {
  const req = {} as TenantScopedRequest;

  function makeServiceWithResult(result: unknown) {
    const executeKw = jest.fn().mockResolvedValue(result);
    const context = {
      resolveTenantContext: jest.fn().mockResolvedValue({
        keycloakUserId: 'sub-1',
        accountId: 'account-1',
        callerTenantId: 'tenant-1',
      }),
      resolveCompanyTarget: jest.fn().mockResolvedValue(42),
      resolveCredentials: jest.fn().mockResolvedValue({ db: 'db1', uid: 7, password: 'pw' }),
    } as unknown as CompanyOdooContextService;
    const odoo = { executeKw } as unknown as OdooRpcService;
    const audit = {} as unknown as AuditService;
    const handoffs = {} as unknown as CompanyMutationHandoffService;
    return new CompanySetupService(context, odoo, audit, handoffs);
  }

  it('rejects an unrecognized currentStep with a generic 5xx, not a malformed 200', async () => {
    const service = makeServiceWithResult({
      currentStep: 'not-a-real-step',
      setupComplete: false,
      values: {},
      version: 1,
      stale: false,
    });
    await expect(service.getState(req)).rejects.toThrow(InternalServerErrorException);
  });

  it('rejects a negative version with a generic 5xx', async () => {
    const service = makeServiceWithResult({
      currentStep: 'country',
      setupComplete: false,
      values: {},
      version: -1,
      stale: false,
    });
    await expect(service.getState(req)).rejects.toThrow(InternalServerErrorException);
  });

  it('rejects a non-object values field with a generic 5xx', async () => {
    const service = makeServiceWithResult({
      currentStep: 'country',
      setupComplete: false,
      values: null,
      version: 1,
      stale: false,
    });
    await expect(service.getState(req)).rejects.toThrow(InternalServerErrorException);
  });

  it('rejects private-model/RPC keys nested inside an otherwise valid values object', async () => {
    const service = makeServiceWithResult({
      currentStep: 'country',
      setupComplete: false,
      values: { country: 'AE', jsonrpc: '2.0', model: 'res.company' },
      version: 1,
      stale: false,
    });
    await expect(service.getState(req)).rejects.toThrow(InternalServerErrorException);
  });
});

/**
 * T056 round-5 binding resolution (item 1) — the Round-4 rejection's core finding: unit
 * tests that mock `CompanyOdooContextService.resolve()` as a single resolved value cannot
 * prove "zero Odoo RPCs" because they never exercise the REAL boundary where
 * `authenticate`/`res.company` `search` actually happen
 * (`company-odoo-context.service.ts`'s `resolveCredentials`/the old `resolve`). This suite
 * wires a REAL `CompanyOdooContextService` (the actual class, not a mock) to a fake
 * `OdooRpcService` exposing `authenticate`/`executeKw` spies, and a stubbed control-plane
 * `Tenant` repository — the same boundary a real request crosses — so "no Odoo call of any
 * kind" is a true statement about `authenticate` AND `executeKw`, not merely about the one
 * mutation `executeKw` call a mocked `context.resolve()` happened to model.
 */
describe('CompanySetupService + real CompanyOdooContextService boundary (T056 round-5, item 1)', () => {
  const req = {} as TenantScopedRequest;
  const TENANT_ID = 'tenant-real-1';
  const ACCOUNT_ID = 'account-real-1';
  const REAL_COMPANY_ID = 42;
  let originalEnv: Record<string, string | undefined>;

  beforeAll(() => {
    originalEnv = {
      KEMFAI_ODOO_MASTER_PASSWORD: process.env.KEMFAI_ODOO_MASTER_PASSWORD,
      KEMFAI_TENANT_ADMIN_LOGIN: process.env.KEMFAI_TENANT_ADMIN_LOGIN,
      KEMFAI_TENANT_ADMIN_PASSWORD: process.env.KEMFAI_TENANT_ADMIN_PASSWORD,
    };
    process.env.KEMFAI_ODOO_MASTER_PASSWORD = 'master-secret';
    process.env.KEMFAI_TENANT_ADMIN_LOGIN = 'tenant-admin';
    process.env.KEMFAI_TENANT_ADMIN_PASSWORD = 'tenant-admin-secret';
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeRealBoundaryService(
    tenantContextOverrides: {
      keycloakUserId?: string;
      accountId?: string | null;
      callerTenantId?: string | null;
    } = {},
  ) {
    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: unknown) => {
      const name =
        typeof target === 'function' ? (target as { name: string }).name : String(target);
      if (name === 'Tenant') {
        return {
          findOneBy: async () =>
            ({
              id: TENANT_ID,
              accountId: ACCOUNT_ID,
              odooDbName: 'db-real-1',
              odooCompanyId: REAL_COMPANY_ID,
            }) as Partial<Tenant>,
        } as never;
      }
      throw new Error(`unexpected repository requested in this boundary test: ${name}`);
    });

    const authenticate = jest.fn().mockResolvedValue(7);
    const executeKw = jest.fn().mockResolvedValue({
      currentStep: 'identity',
      setupComplete: false,
      values: {},
      version: 1,
      stale: false,
    });
    const odoo = { authenticate, executeKw } as unknown as OdooRpcService;

    const fakeTenantContextResolver = {
      resolveForRequest: jest.fn().mockResolvedValue({
        keycloakUserId: 'sub-real-1',
        accountId: ACCOUNT_ID,
        callerTenantId: TENANT_ID,
        ...tenantContextOverrides,
      }),
    } as unknown as TenantContextResolver;

    // The REAL class under test for this boundary, not a mock.
    const context = new CompanyOdooContextService(fakeTenantContextResolver, odoo);

    const audit = { recordCompanySetupCompleted: jest.fn() } as unknown as AuditService;
    const findOrCreateCompletionHandoff = jest.fn();
    const handoffs = { findOrCreateCompletionHandoff } as unknown as CompanyMutationHandoffService;
    const service = new CompanySetupService(context, odoo, audit, handoffs);
    return { service, authenticate, executeKw, findOrCreateCompletionHandoff };
  }

  const REAL_SCOPE = computeCompanySetupScope(TENANT_ID, ACCOUNT_ID, REAL_COMPANY_ID);

  it('saveStep with a MISSING scope makes zero Odoo RPCs of any kind (no authenticate, no executeKw)', async () => {
    const { service, authenticate, executeKw } = makeRealBoundaryService();

    await expect(
      service.saveStep(req, { step: 'country', values: {} } as never, undefined),
    ).rejects.toThrow(PreconditionFailedException);
    expect(authenticate).not.toHaveBeenCalled();
    expect(executeKw).not.toHaveBeenCalled();
  });

  it('saveStep with a BLANK (whitespace-only) scope makes zero Odoo RPCs of any kind', async () => {
    const { service, authenticate, executeKw } = makeRealBoundaryService();

    await expect(
      service.saveStep(req, { step: 'country', values: {} } as never, '   '),
    ).rejects.toThrow(PreconditionFailedException);
    expect(authenticate).not.toHaveBeenCalled();
    expect(executeKw).not.toHaveBeenCalled();
  });

  it('saveStep with a MISMATCHED (stale) scope makes zero Odoo RPCs of any kind', async () => {
    const { service, authenticate, executeKw } = makeRealBoundaryService();
    const staleScope = computeCompanySetupScope('some-other-tenant', 'some-other-account', 999);

    await expect(
      service.saveStep(req, { step: 'country', values: {} } as never, staleScope),
    ).rejects.toThrow(PreconditionFailedException);
    expect(authenticate).not.toHaveBeenCalled();
    expect(executeKw).not.toHaveBeenCalled();
  });

  it('completeSetup with a MISSING/BLANK/MISMATCHED scope makes zero Odoo RPCs of any kind and never creates a handoff', async () => {
    for (const badScope of [undefined, '   ', computeCompanySetupScope('x', 'y', 1)]) {
      const { service, authenticate, executeKw, findOrCreateCompletionHandoff } =
        makeRealBoundaryService();
      await expect(service.completeSetup(req, badScope)).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(authenticate).not.toHaveBeenCalled();
      expect(executeKw).not.toHaveBeenCalled();
      expect(findOrCreateCompletionHandoff).not.toHaveBeenCalled();
    }
  });

  it('getState/saveStep/completeSetup with an unresolved principal (null accountId) make zero Odoo RPCs of any kind', async () => {
    const {
      service: getStateService,
      authenticate: getStateAuth,
      executeKw: getStateExec,
    } = makeRealBoundaryService({ accountId: null });
    await expect(getStateService.getState(req)).rejects.toThrow(InternalServerErrorException);
    expect(getStateAuth).not.toHaveBeenCalled();
    expect(getStateExec).not.toHaveBeenCalled();

    const {
      service: saveStepService,
      authenticate: saveAuth,
      executeKw: saveExec,
    } = makeRealBoundaryService({ accountId: null });
    await expect(
      saveStepService.saveStep(req, { step: 'country', values: {} } as never, 'any'),
    ).rejects.toThrow(InternalServerErrorException);
    expect(saveAuth).not.toHaveBeenCalled();
    expect(saveExec).not.toHaveBeenCalled();

    const {
      service: completeService,
      authenticate: completeAuth,
      executeKw: completeExec,
    } = makeRealBoundaryService({ accountId: null });
    await expect(completeService.completeSetup(req, 'any')).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(completeAuth).not.toHaveBeenCalled();
    expect(completeExec).not.toHaveBeenCalled();
  });

  it('saveStep with a MATCHING scope DOES reach Odoo — proving this boundary test is not vacuously green', async () => {
    const { service, authenticate, executeKw } = makeRealBoundaryService();

    const result = await service.saveStep(
      req,
      { step: 'country', values: { country: 'AE' } } as never,
      REAL_SCOPE,
    );
    expect(result.currentStep).toBe('identity');
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(executeKw).toHaveBeenCalledWith(
      'db-real-1',
      7,
      'tenant-admin-secret',
      'res.company',
      'kemfai_setup_save_step',
      [[REAL_COMPANY_ID], 'country', { country: 'AE' }, null],
    );
  });
});
