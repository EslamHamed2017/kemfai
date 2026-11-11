import {
  ForbiddenException,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TenantScopedRequest } from '../../../common/tenant-context/tenant-context.model';
import { AccountingMutationHandoffState } from '../entities/accounting-mutation-handoff.entity';
import { AccountsService } from './accounts.service';

const TENANT = '49494949-1111-4111-8111-111111111111';
const FIXTURE_USER_ID = ['fixture', 'user'].join('-');
const ACTOR = '49494949-2222-4222-8222-222222222222';
const COMPANY = '49494949-3333-4333-8333-333333333333';
const OPERATION = '49494949-4444-4444-8444-444444444444';
const RESOURCE = '49494949-5555-4555-8555-555555555555';
const AUDIT_EVENT = '49494949-6666-4666-8666-666666666666';

function request(roles = ['accounting.coa.create']): TenantScopedRequest {
  return {
    method: 'POST',
    path: '/accounting/v1/accounts',
    headers: {
      'idempotency-key': 'create-cash',
      'x-correlation-id': 'corr-t049',
    },
    auth: { keycloakUserId: FIXTURE_USER_ID, roles },
    tenantContext: { keycloakUserId: FIXTURE_USER_ID, accountId: ACTOR, callerTenantId: TENANT },
  } as unknown as TenantScopedRequest;
}

function accountResult() {
  return {
    id: RESOURCE,
    code: '1100',
    name_en: 'Cash',
    name_ar: 'النقد',
    account_type: 'asset_cash',
    node_kind: 'posting',
    parent_id: null,
    active: true,
    version: 1,
    audit_event_id: AUDIT_EVENT,
  };
}

describe('AccountsService durable permissioned mutations (T049)', () => {
  function harness(
    options: { state?: AccountingMutationHandoffState; auditFailure?: boolean } = {},
  ) {
    const context = {
      resolve: jest.fn().mockResolvedValue({
        tenantId: TENANT,
        accountId: ACTOR,
        companyUuid: COMPANY,
        db: 'private_tenant_a',
        uid: 7,
        password: 'private-password',
        companyId: 91,
      }),
    };
    const state = options.state ?? AccountingMutationHandoffState.PENDING;
    const handoff = {
      id: OPERATION,
      tenantId: TENANT,
      companyUuid: COMPANY,
      actorAccountId: ACTOR,
      principalIdentity: FIXTURE_USER_ID,
      odooDbName: 'private_tenant_a',
      odooCompanyId: 91,
      callerScope: `keycloak:keycloak-t049:tenant:${TENANT}`,
      method: 'POST',
      route: '/accounting/v1/accounts',
      action: 'account.create',
      idempotencyKey: 'create-cash',
      requestFingerprint: 'fingerprint',
      requestPayloadRedacted: {},
      state,
      finalResponse: state === AccountingMutationHandoffState.PENDING ? null : accountResult(),
      retryCount: 0,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      createdAt: new Date('2026-11-03T00:00:00Z'),
      updatedAt: new Date('2026-11-03T00:00:00Z'),
      odooCommittedAt: new Date('2026-11-03T00:00:01Z'),
      auditedAt: state === AccountingMutationHandoffState.AUDITED ? new Date() : null,
    };
    const handoffs = {
      findOrCreateHandoff: jest
        .fn()
        .mockImplementation(async (input) => Object.assign({}, handoff, input)),
      markOdooCommitted: jest.fn().mockResolvedValue(undefined),
      markRejected: jest.fn().mockResolvedValue(undefined),
      markAudited: jest.fn().mockResolvedValue(undefined),
      scheduleRetryBackoff: jest.fn().mockResolvedValue(undefined),
    };
    const odoo = { executeKw: jest.fn().mockResolvedValue(accountResult()) };
    const audit = {
      recordAccountingMutation: options.auditFailure
        ? jest.fn().mockRejectedValue(new Error('mirror down'))
        : jest.fn().mockResolvedValue(accountResult()),
      recordPreDomainDenial: jest.fn().mockResolvedValue(undefined),
    };
    return {
      service: new AccountsService(
        context as never,
        odoo as never,
        handoffs as never,
        audit as never,
      ),
      context,
      handoffs,
      odoo,
      audit,
    };
  }

  const create = {
    code: '1100',
    name: { en: 'Cash', ar: 'النقد' },
    accountType: 'asset_cash',
    nodeKind: 'posting' as const,
    parentId: null,
    active: true,
  };

  it('uses only guarded company-scoped methods for account reads', async () => {
    const h = harness();
    (h.odoo.executeKw as jest.Mock)
      .mockResolvedValueOnce({ items: [accountResult()], next_cursor: null })
      .mockResolvedValueOnce(accountResult());
    const req = request(['accounting.coa.view']);
    await expect(
      h.service.list(req, COMPANY, { limit: 25, active: true, nodeKind: 'posting' }),
    ).resolves.toMatchObject({ items: [{ id: RESOURCE, companyId: COMPANY }], nextCursor: null });
    await expect(h.service.get(req, COMPANY, RESOURCE)).resolves.toMatchObject({
      id: RESOURCE,
      companyId: COMPANY,
      version: 1,
    });
    expect(h.odoo.executeKw).toHaveBeenNthCalledWith(
      1,
      'private_tenant_a',
      7,
      'private-password',
      'account.account',
      'kemfai_list_accounts',
      [91, { limit: 25, active: true, nodeKind: 'posting' }],
      { context: { allowed_company_ids: [91], force_company: 91 } },
    );
    expect(h.odoo.executeKw).toHaveBeenNthCalledWith(
      2,
      'private_tenant_a',
      7,
      'private-password',
      'account.account',
      'kemfai_read_account',
      [RESOURCE, 91],
      { context: { allowed_company_ids: [91], force_company: 91 } },
    );
  });

  it('persists an opaque denial when an authenticated read cannot resolve a scoped UUID', async () => {
    const h = harness();
    h.odoo.executeKw.mockRejectedValueOnce(new Error('ACCOUNT_NOT_FOUND'));
    const req = request(['accounting.coa.view']);
    req.method = 'GET';

    await expect(h.service.get(req, COMPANY, RESOURCE)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.audit.recordPreDomainDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        companyUuid: COMPANY,
        actorAccountId: ACTOR,
        route: `/v1/accounting/accounts/${RESOURCE}`,
        reason: 'company_scope_denied',
      }),
    );
  });

  it('commits through the operation UUID, mirrors audit, marks audited, then returns receipt/ETag data', async () => {
    const h = harness();
    await expect(h.service.create(request(), COMPANY, create)).resolves.toEqual({
      operationId: OPERATION,
      auditEventId: AUDIT_EVENT,
      correlationId: 'corr-t049',
      replayed: false,
      resource: {
        id: RESOURCE,
        companyId: COMPANY,
        code: '1100',
        name: { en: 'Cash', ar: 'النقد' },
        accountType: 'asset_cash',
        nodeKind: 'posting',
        parentId: null,
        active: true,
        version: 1,
        selectableForDraftLines: true,
      },
    });
    expect(h.odoo.executeKw).toHaveBeenCalledWith(
      'private_tenant_a',
      7,
      'private-password',
      'account.account',
      'kemfai_create_account',
      [OPERATION, FIXTURE_USER_ID, expect.objectContaining({ company_id: 91, code: '1100' })],
      { context: { allowed_company_ids: [91], force_company: 91 } },
    );
    expect(h.handoffs.markOdooCommitted).toHaveBeenCalledWith(OPERATION, accountResult());
    expect(h.audit.recordAccountingMutation.mock.invocationCallOrder[0]).toBeLessThan(
      h.handoffs.markAudited.mock.invocationCallOrder[0],
    );
    expect(h.handoffs.markAudited).toHaveBeenCalledWith(OPERATION);
  });

  it('returns an audited replay without calling Odoo or duplicating the mirror', async () => {
    const h = harness({ state: AccountingMutationHandoffState.AUDITED });
    await expect(h.service.create(request(), COMPANY, create)).resolves.toMatchObject({
      operationId: OPERATION,
      replayed: true,
      resource: { id: RESOURCE, version: 1 },
    });
    expect(h.odoo.executeKw).not.toHaveBeenCalled();
    expect(h.audit.recordAccountingMutation).not.toHaveBeenCalled();
    expect(h.handoffs.markAudited).not.toHaveBeenCalled();
  });

  it('preserves optimistic version data and maps PATCH to the guarded update method', async () => {
    const h = harness();
    const req = request(['accounting.coa.edit']);
    req.method = 'PATCH';
    (h.odoo.executeKw as jest.Mock).mockResolvedValue({ ...accountResult(), version: 4 });
    await expect(
      h.service.update(req, COMPANY, RESOURCE, 3, { name: { en: 'Bank', ar: 'البنك' } }),
    ).resolves.toMatchObject({ resource: { id: RESOURCE, version: 4 } });
    expect(h.odoo.executeKw).toHaveBeenCalledWith(
      'private_tenant_a',
      7,
      'private-password',
      'account.account',
      'kemfai_update_account',
      [RESOURCE, OPERATION, FIXTURE_USER_ID, 3, { name_en: 'Bank', name_ar: 'البنك' }, 91],
      { context: { allowed_company_ids: [91], force_company: 91 } },
    );
    expect(h.handoffs.findOrCreateHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'account.update', method: 'PATCH' }),
    );
  });

  it('terminally rejects stale account mutations without scheduling recovery', async () => {
    const h = harness();
    const req = request(['accounting.coa.edit']);
    req.method = 'PATCH';
    h.odoo.executeKw.mockRejectedValueOnce(new Error('STALE_VERSION'));

    await expect(
      h.service.update(req, COMPANY, RESOURCE, 3, { name: { en: 'Bank', ar: 'البنك' } }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
    expect(h.handoffs.markRejected).toHaveBeenCalledWith(OPERATION, 'STALE_VERSION');
    expect(h.handoffs.scheduleRetryBackoff).not.toHaveBeenCalled();
  });

  it('passes the resolved company scope to account deactivation', async () => {
    const h = harness();
    const req = request(['accounting.coa.edit']);
    req.method = 'PATCH';

    await expect(h.service.deactivate(req, COMPANY, RESOURCE, 3)).resolves.toMatchObject({
      resource: { id: RESOURCE },
    });

    expect(h.odoo.executeKw).toHaveBeenCalledWith(
      'private_tenant_a',
      7,
      'private-password',
      'account.account',
      'kemfai_deactivate_account',
      [RESOURCE, OPERATION, FIXTURE_USER_ID, 3, 91],
      { context: { allowed_company_ids: [91], force_company: 91 } },
    );
  });

  it('treats an Odoo tenant-audit infrastructure failure as retryable, not validation', async () => {
    const h = harness();
    h.odoo.executeKw.mockRejectedValueOnce(new Error('ACCOUNT_AUDIT_TEST_FAULT'));
    await expect(h.service.create(request(), COMPANY, create)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(h.handoffs.markOdooCommitted).not.toHaveBeenCalled();
    expect(h.handoffs.scheduleRetryBackoff).toHaveBeenCalledWith(OPERATION, expect.any(Number));
  });

  it('withholds success when the platform audit mirror fails and leaves recovery retryable', async () => {
    const h = harness({ auditFailure: true });
    await expect(h.service.create(request(), COMPANY, create)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(h.handoffs.markOdooCommitted).toHaveBeenCalledTimes(1);
    expect(h.handoffs.markAudited).not.toHaveBeenCalled();
    expect(h.handoffs.scheduleRetryBackoff).toHaveBeenCalledWith(OPERATION, expect.any(Number));
  });

  it('denies a caller without Create before any Odoo mutation and persists an opaque denial', async () => {
    const h = harness();
    await expect(
      h.service.create(request(['accounting.coa.view']), COMPANY, create),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.odoo.executeKw).not.toHaveBeenCalled();
    expect(h.handoffs.findOrCreateHandoff).not.toHaveBeenCalled();
    expect(h.audit.recordPreDomainDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        companyUuid: COMPANY,
        actorAccountId: ACTOR,
        reason: 'permission_denied',
      }),
    );
    expect(JSON.stringify(h.audit.recordPreDomainDenial.mock.calls)).not.toContain(
      'private_tenant_a',
    );
  });
});
