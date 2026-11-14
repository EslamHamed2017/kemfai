import {
  ForbiddenException,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TenantScopedRequest } from '../../../common/tenant-context/tenant-context.model';
import { AccountingMutationHandoffState } from '../entities/accounting-mutation-handoff.entity';
import { DimensionsService } from './dimensions.service';

const TENANT = '92929292-1111-4111-8111-111111111111';
const FIXTURE_USER_ID = ['fixture', 'user'].join('-');
const ACTOR = '92929292-2222-4222-8222-222222222222';
const COMPANY = '92929292-3333-4333-8333-333333333333';
const OPERATION = '92929292-4444-4444-8444-444444444444';
const RESOURCE = '92929292-5555-4555-8555-555555555555';
const DEFINITION = '92929292-6666-4666-8666-666666666666';
const AUDIT = '92929292-7777-4777-8777-777777777777';

function request(roles = ['accounting.coa.create']): TenantScopedRequest {
  return {
    method: 'POST',
    path: '/v1/accounting/dimension-definitions',
    headers: { 'idempotency-key': 'dimension-key', 'x-correlation-id': 'corr-t092' },
    auth: { keycloakUserId: FIXTURE_USER_ID, roles },
    tenantContext: { keycloakUserId: FIXTURE_USER_ID, accountId: ACTOR, callerTenantId: TENANT },
  } as unknown as TenantScopedRequest;
}

function definitionResult() {
  return {
    id: RESOURCE,
    key: 'project_custom',
    kind: 'custom',
    name_en: 'Project',
    name_ar: 'المشروع',
    active: true,
    version: 1,
    audit_event_id: AUDIT,
  };
}
function ruleResult() {
  return {
    id: RESOURCE,
    account_id: null,
    transaction_type: 'manual_journal',
    dimension_definition_id: DEFINITION,
    requirement: 'required',
    effective_from: '2026-01-01',
    effective_to: null,
    active: true,
    version: 2,
    audit_event_id: AUDIT,
  };
}

describe('DimensionsService durable scoped CRUD (T092)', () => {
  function harness(
    options: {
      result?: Record<string, unknown>;
      state?: AccountingMutationHandoffState;
      auditFailure?: boolean;
    } = {},
  ) {
    const result = options.result ?? definitionResult();
    const state = options.state ?? AccountingMutationHandoffState.PENDING;
    const context = {
      resolve: jest.fn().mockResolvedValue({
        tenantId: TENANT,
        accountId: ACTOR,
        companyUuid: COMPANY,
        db: 'private_tenant_a',
        uid: 7,
        password: 'secret',
        companyId: 91,
      }),
    };
    const handoff = {
      id: OPERATION,
      tenantId: TENANT,
      companyUuid: COMPANY,
      actorAccountId: ACTOR,
      principalIdentity: FIXTURE_USER_ID,
      odooDbName: 'private_tenant_a',
      odooCompanyId: 91,
      callerScope: `keycloak:keycloak-t092:tenant:${TENANT}`,
      method: 'POST',
      route: '/v1/accounting/dimension-definitions',
      action: 'dimension.definition.create',
      idempotencyKey: 'dimension-key',
      requestFingerprint: 'fp',
      requestPayloadRedacted: {},
      state,
      finalResponse: state === AccountingMutationHandoffState.PENDING ? null : result,
      retryCount: 0,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      odooCommittedAt: null,
      auditedAt: null,
    };
    const handoffs = {
      findOrCreateHandoff: jest
        .fn()
        .mockImplementation(async (input) => ({ ...handoff, ...input })),
      markOdooCommitted: jest.fn(),
      markRejected: jest.fn(),
      markAudited: jest.fn(),
      scheduleRetryBackoff: jest.fn(),
    };
    const odoo = { executeKw: jest.fn().mockResolvedValue(result) };
    const audit = {
      recordAccountingMutation: options.auditFailure
        ? jest.fn().mockRejectedValue(new Error('down'))
        : jest.fn(),
      recordPreDomainDenial: jest.fn(),
    };
    return {
      service: new DimensionsService(
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

  it('creates a definition through an operation UUID and returns a scoped receipt', async () => {
    const h = harness();
    await expect(
      h.service.createDefinition(request(), COMPANY, {
        key: 'project_custom',
        name: { en: 'Project', ar: 'المشروع' },
        kind: 'custom',
        active: true,
      }),
    ).resolves.toMatchObject({
      operationId: OPERATION,
      auditEventId: AUDIT,
      resource: { id: RESOURCE, companyId: COMPANY, key: 'project_custom', version: 1 },
    });
    expect(h.odoo.executeKw).toHaveBeenCalledWith(
      'private_tenant_a',
      7,
      'secret',
      'kemfai.dimension.definition',
      'kemfai_create_dimension_definition',
      [
        OPERATION,
        FIXTURE_USER_ID,
        expect.objectContaining({ company_id: 91, key: 'project_custom' }),
      ],
      { context: { allowed_company_ids: [91], force_company: 91 } },
    );
  });

  it('maps rule updates to guarded optimistic concurrency and stale versions to 412', async () => {
    const h = harness({ result: ruleResult() });
    const req = request(['accounting.coa.edit']);
    req.method = 'PATCH';
    await expect(
      h.service.updateRule(req, COMPANY, RESOURCE, 1, { requirement: 'required' }),
    ).resolves.toMatchObject({
      resource: { id: RESOURCE, version: 2, transactionType: 'manual_journal' },
    });
    expect(h.odoo.executeKw).toHaveBeenCalledWith(
      'private_tenant_a',
      7,
      'secret',
      'kemfai.dimension.rule',
      'kemfai_update_dimension_rule',
      [RESOURCE, OPERATION, FIXTURE_USER_ID, 1, { requirement: 'required' }, 91],
      { context: { allowed_company_ids: [91], force_company: 91 } },
    );
    h.odoo.executeKw.mockRejectedValueOnce(new Error('STALE_VERSION'));
    await expect(
      h.service.updateRule(req, COMPANY, RESOURCE, 1, { active: false }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
    expect(h.handoffs.markRejected).toHaveBeenCalledWith(OPERATION, 'STALE_VERSION');
  });

  it('lists values only through a company-scoped guarded method', async () => {
    const h = harness();
    h.odoo.executeKw.mockResolvedValueOnce({
      items: [
        {
          id: RESOURCE,
          definition_id: DEFINITION,
          code: 'P1',
          name_en: 'P1',
          name_ar: 'م1',
          active: true,
          version: 1,
        },
      ],
      next_cursor: null,
    });
    await expect(
      h.service.listValues(request(['accounting.coa.view']), COMPANY, {
        limit: 25,
        definitionId: DEFINITION,
        active: true,
      }),
    ).resolves.toMatchObject({
      items: [{ id: RESOURCE, companyId: COMPANY, definitionId: DEFINITION }],
    });
    expect(h.odoo.executeKw).toHaveBeenCalledWith(
      'private_tenant_a',
      7,
      'secret',
      'kemfai.dimension.value',
      'kemfai_list_dimension_values',
      [91, { limit: 25, definitionId: DEFINITION, active: true }],
      { context: { allowed_company_ids: [91], force_company: 91 } },
    );
  });

  it('withholds success when platform audit fails and leaves recovery retryable', async () => {
    const h = harness({ auditFailure: true });
    await expect(
      h.service.createDefinition(request(), COMPANY, {
        key: 'project_custom',
        name: { en: 'Project', ar: 'المشروع' },
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(h.handoffs.markAudited).not.toHaveBeenCalled();
    expect(h.handoffs.scheduleRetryBackoff).toHaveBeenCalledWith(OPERATION, expect.any(Number));
  });

  it('persists an opaque denial when a scoped dimension mutation cannot resolve its UUID', async () => {
    const h = harness();
    const req = request(['accounting.coa.edit']);
    req.method = 'PATCH';
    h.odoo.executeKw.mockRejectedValueOnce(new Error('DIMENSION_DEFINITION_NOT_FOUND'));

    await expect(
      h.service.updateDefinition(req, COMPANY, RESOURCE, 1, { active: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.audit.recordPreDomainDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        operationUuid: OPERATION,
        tenantId: TENANT,
        companyUuid: COMPANY,
        actorAccountId: ACTOR,
        route: `/v1/accounting/dimension-definitions/${RESOURCE}`,
        reason: 'company_scope_denied',
      }),
    );
  });

  it('denies unauthorized mutation before handoff or Odoo', async () => {
    const h = harness();
    await expect(
      h.service.createDefinition(request(['accounting.coa.view']), COMPANY, {
        key: 'project_custom',
        name: { en: 'Project', ar: 'المشروع' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.handoffs.findOrCreateHandoff).not.toHaveBeenCalled();
    expect(h.odoo.executeKw).not.toHaveBeenCalled();
  });
});
