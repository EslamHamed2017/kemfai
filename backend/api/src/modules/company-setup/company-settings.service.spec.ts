import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { CompanySettingsService } from './company-settings.service';
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
 * T055 unit coverage of `CompanySettingsService`'s durable-handoff orchestration (arbiter
 * binding resolution, point 5): the handoff is committed before the Odoo RPC, the
 * `Idempotency-Key`/fingerprint reconciliation itself lives in
 * `CompanyMutationHandoffService` (covered separately — see
 * `company-mutation-handoff.service.spec.ts`), and this service's own job is to build
 * the right handoff-creation request, run the RPC/audit around whatever handoff comes
 * back, and preserve the 409-vs-422 translation difference from `CompanySetupService`.
 */
describe('CompanySettingsService (T055, unit)', () => {
  const occurredAt = new Date('2026-10-05T00:00:00.000Z');

  function makeReq(
    headers: Record<string, string | string[] | undefined> = {},
  ): TenantScopedRequest {
    return { headers, auth: { keycloakUserId: 'sub-1' } } as unknown as TenantScopedRequest;
  }

  function makeHandoff(
    overrides: Partial<CompanyMutationHandoffRow> = {},
  ): CompanyMutationHandoffRow {
    return {
      id: 'handoff-settings-1',
      action: CompanyMutationAction.SETTINGS_UPDATE,
      tenantId: 'tenant-1',
      actorAccountId: 'account-1',
      principalIdentity: 'sub-1',
      odooDbName: 'db1',
      odooCompanyId: 42,
      requestFingerprint: 'fp',
      requestPayload: { legal_name: 'Acme Holdings' },
      occurredAt,
      idempotencyKey: null,
      callerScope: null,
      method: 'PUT',
      route: '/companies/current/settings',
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
    handoff?: CompanyMutationHandoffRow | (() => Promise<CompanyMutationHandoffRow>);
    recordCompanySettingsUpdated?: jest.Mock;
    tenantContext?: Record<string, unknown>;
  }) {
    const executeKw = options.executeKw ?? jest.fn();
    const recordCompanySettingsUpdated =
      options.recordCompanySettingsUpdated ?? jest.fn().mockResolvedValue(undefined);
    const context = {
      resolve: jest.fn().mockResolvedValue({ db: 'db1', uid: 7, password: 'pw', companyId: 42 }),
      resolveTenantContext: jest.fn().mockResolvedValue(
        options.tenantContext ?? {
          keycloakUserId: 'sub-1',
          accountId: 'account-1',
          callerTenantId: 'tenant-1',
        },
      ),
    } as unknown as CompanyOdooContextService;
    const odoo = { executeKw } as unknown as OdooRpcService;
    const audit = { recordCompanySettingsUpdated } as unknown as AuditService;
    const findOrCreateSettingsHandoff =
      typeof options.handoff === 'function'
        ? jest.fn(options.handoff)
        : jest.fn().mockResolvedValue(options.handoff ?? makeHandoff());
    const markOdooCommitted = jest.fn().mockResolvedValue(undefined);
    const markAudited = jest.fn().mockResolvedValue(undefined);
    const deletePending = jest.fn().mockResolvedValue(undefined);
    const scheduleRetryBackoff = jest.fn().mockResolvedValue(undefined);
    const handoffs = {
      findOrCreateSettingsHandoff,
      markOdooCommitted,
      markAudited,
      deletePending,
      scheduleRetryBackoff,
    } as unknown as CompanyMutationHandoffService;
    return {
      service: new CompanySettingsService(context, odoo, audit, handoffs),
      executeKw,
      recordCompanySettingsUpdated,
      findOrCreateSettingsHandoff,
      markOdooCommitted,
      markAudited,
      deletePending,
      scheduleRetryBackoff,
    };
  }

  it('getSettings returns the Odoo-reported values/setupComplete unchanged', async () => {
    const executeKw = jest.fn().mockResolvedValue({
      values: { country: 'AE', legal_name: 'Acme FZ' },
      setupComplete: true,
    });
    const { service } = makeService({ executeKw });

    const result = await service.getSettings(makeReq());

    expect(result).toEqual({
      values: { country: 'AE', legal_name: 'Acme FZ' },
      setupComplete: true,
    });
  });

  it('getSettings translates KEMFAI_SETUP_INCOMPLETE into the canonical 409 CompanySetupIncompleteError body', async () => {
    const executeKw = jest
      .fn()
      .mockRejectedValue(
        new Error('KEMFAI_SETUP_INCOMPLETE: settings are not reachable until setup is complete.'),
      );
    const { service } = makeService({ executeKw });

    await expect(service.getSettings(makeReq())).rejects.toMatchObject({
      status: 409,
      response: {
        statusCode: 409,
        message: 'settings are not reachable until setup is complete.',
        setupComplete: false,
      },
    });
  });

  it('updateSettings commits a handoff before the Odoo call and audits exactly once from the handoff identity', async () => {
    const executeKw = jest.fn().mockResolvedValue({
      values: { legal_name: 'Acme Holdings' },
      setupComplete: true,
      changedFields: ['legal_name'],
    });
    const {
      service,
      findOrCreateSettingsHandoff,
      markOdooCommitted,
      markAudited,
      recordCompanySettingsUpdated,
    } = makeService({ executeKw });

    const result = await service.updateSettings(makeReq(), {
      values: { legal_name: 'Acme Holdings' },
    });

    expect(result).toEqual({ values: { legal_name: 'Acme Holdings' }, setupComplete: true });
    expect(findOrCreateSettingsHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        actorAccountId: 'account-1',
        requestPayload: { legal_name: 'Acme Holdings' },
        idempotencyKey: null,
        method: 'PUT',
        route: '/companies/current/settings',
      }),
    );
    expect(markOdooCommitted).toHaveBeenCalledWith(
      'handoff-settings-1',
      expect.objectContaining({ changedFields: ['legal_name'] }),
    );
    expect(markAudited).toHaveBeenCalledWith('handoff-settings-1');
    expect(recordCompanySettingsUpdated).toHaveBeenCalledWith({
      accountId: 'account-1',
      tenantId: 'tenant-1',
      companyId: 'tenant-1',
      odooDbName: 'db1',
      odooCompanyId: 42,
      changedFields: ['legal_name'],
      occurredAt,
      operationUuid: 'handoff-settings-1',
    });
  });

  it('forwards the Idempotency-Key header into the handoff-creation request', async () => {
    const executeKw = jest.fn().mockResolvedValue({
      values: { legal_name: 'Acme Holdings' },
      setupComplete: true,
      changedFields: ['legal_name'],
    });
    const { service, findOrCreateSettingsHandoff } = makeService({ executeKw });

    await service.updateSettings(makeReq({ 'idempotency-key': 'client-key-1' }), {
      values: { legal_name: 'Acme Holdings' },
    });

    expect(findOrCreateSettingsHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'client-key-1' }),
    );
  });

  it('a handoff already audited (same-key/same-body replay) short-circuits: no Odoo call, no re-audit', async () => {
    const handoff = makeHandoff({
      state: CompanyMutationHandoffState.AUDITED,
      finalResponse: {
        values: { legal_name: 'After' },
        setupComplete: true,
        changedFields: ['legal_name'],
      },
    });
    const { service, executeKw, recordCompanySettingsUpdated } = makeService({ handoff });

    const result = await service.updateSettings(makeReq({ 'idempotency-key': 'retry-key' }), {
      values: { legal_name: 'After' },
    });

    expect(result).toEqual({ values: { legal_name: 'After' }, setupComplete: true });
    expect(executeKw).not.toHaveBeenCalled();
    expect(recordCompanySettingsUpdated).not.toHaveBeenCalled();
  });

  it('a different fingerprint under the same scoped key propagates the handoff service 409, never audits', async () => {
    const { service, recordCompanySettingsUpdated, executeKw } = makeService({
      handoff: () =>
        Promise.reject(
          new ConflictException(
            'Idempotency-Key was already used with a different request payload.',
          ),
        ),
    });

    await expect(
      service.updateSettings(makeReq({ 'idempotency-key': 'retry-key' }), {
        values: { legal_name: 'Different' },
      }),
    ).rejects.toThrow(ConflictException);
    expect(executeKw).not.toHaveBeenCalled();
    expect(recordCompanySettingsUpdated).not.toHaveBeenCalled();
  });

  it('updateSettings before completion is rejected with 409, releases the pending handoff, never audits', async () => {
    const executeKw = jest
      .fn()
      .mockRejectedValue(
        new Error('KEMFAI_SETUP_INCOMPLETE: settings are not reachable until setup is complete.'),
      );
    const { service, deletePending, recordCompanySettingsUpdated } = makeService({ executeKw });

    await expect(
      service.updateSettings(makeReq(), { values: { legal_name: 'X' } }),
    ).rejects.toThrow(ConflictException);
    expect(deletePending).toHaveBeenCalledWith('handoff-settings-1');
    expect(recordCompanySettingsUpdated).not.toHaveBeenCalled();
  });

  it('B1: an ambiguous RPC failure (not a typed KEMFAI_ fault) never deletes the handoff — it is left retryable and the caller gets a typed 5xx', async () => {
    const executeKw = jest.fn().mockRejectedValue(new Error('ECONNRESET: socket hang up'));
    const { service, deletePending, scheduleRetryBackoff, recordCompanySettingsUpdated } =
      makeService({ executeKw });

    await expect(
      service.updateSettings(makeReq(), { values: { legal_name: 'X' } }),
    ).rejects.toThrow(InternalServerErrorException);
    expect(deletePending).not.toHaveBeenCalled();
    expect(scheduleRetryBackoff).toHaveBeenCalledWith('handoff-settings-1', expect.any(Number));
    expect(recordCompanySettingsUpdated).not.toHaveBeenCalled();
  });

  it('refuses to create a handoff or audit without a resolved account/tenant', async () => {
    const { service, findOrCreateSettingsHandoff } = makeService({
      tenantContext: { keycloakUserId: 'sub-1', accountId: null, callerTenantId: 'tenant-1' },
    });

    await expect(
      service.updateSettings(makeReq(), { values: { legal_name: 'X' } }),
    ).rejects.toThrow(InternalServerErrorException);
    expect(findOrCreateSettingsHandoff).not.toHaveBeenCalled();
  });
});
