import { PreconditionFailedException, UnprocessableEntityException } from '@nestjs/common';
import { TenantScopedRequest } from '../../../common/tenant-context/tenant-context.model';
import { AccountingMutationHandoffState } from '../entities/accounting-mutation-handoff.entity';
import { DraftsService } from './drafts.service';

const TENANT = '51515151-1111-4111-8111-111111111111';
const FIXTURE_USER_ID = ['fixture', 'user'].join('-');
const ACTOR = '51515151-2222-4222-8222-222222222222';
const COMPANY = '51515151-3333-4333-8333-333333333333';
const OPERATION = '51515151-4444-4444-8444-444444444444';
const DRAFT = '51515151-5555-4555-8555-555555555555';
const LINE = '51515151-6666-4666-8666-666666666666';
const ACCOUNT = '51515151-7777-4777-8777-777777777777';
const AUDIT = '51515151-8888-4888-8888-888888888888';
const DEFINITION = '51515151-9999-4999-8999-999999999999';
const VALUE = '52525252-1111-4111-8111-111111111111';
const RULE = '52525252-2222-4222-8222-222222222222';

function request(roles = ['accounting.drafts.edit']): TenantScopedRequest {
  return {
    method: 'POST',
    path: '/v1/accounting/drafts',
    headers: {
      'idempotency-key': 'draft-one',
      'x-correlation-id': 'corr-t051',
    },
    auth: { keycloakUserId: FIXTURE_USER_ID, roles },
    tenantContext: { keycloakUserId: FIXTURE_USER_ID, accountId: ACTOR, callerTenantId: TENANT },
  } as unknown as TenantScopedRequest;
}

function body() {
  return {
    journalId: DRAFT,
    accountingDate: '2026-11-03',
    description: 'safe',
    transactionType: 'manual_journal' as const,
    source: null,
    lines: [
      {
        id: LINE,
        sequence: 1,
        accountId: ACCOUNT,
        transactionCurrencyCode: 'AED',
        transactionPrecision: 2,
        transactionCurrencyMetadataVersion: 'v1',
        companyBaseCurrencyCode: 'AED',
        basePrecision: 2,
        baseCurrencyMetadataVersion: 'v1',
        currencyConfigurationVersion: 1,
        transactionDebit: '1.2300',
        transactionCredit: '0',
        baseDebit: '1.2300',
        baseCredit: '0',
        rateReference: null,
        rateEffectiveDate: null,
        dimensions: [],
      },
    ],
  };
}

function upstream(errors: unknown[] = []) {
  return {
    id: DRAFT,
    company_id: 91,
    version: 1,
    status: 'draft',
    journal_id: DRAFT,
    accounting_date: '2026-11-03',
    description: 'safe',
    transaction_type: 'manual_journal',
    source: null,
    lines: [
      {
        id: LINE,
        sequence: 1,
        account_id: ACCOUNT,
        account_code: '1100',
        account_name_en: 'Cash',
        account_name_ar: 'النقد',
        transaction_currency_code: 'AED',
        transaction_precision: 2,
        transaction_currency_metadata_version: 'v1',
        company_base_currency_code: 'AED',
        base_precision: 2,
        base_currency_metadata_version: 'v1',
        currency_configuration_version: 1,
        transaction_debit: '1.2300',
        transaction_credit: '0',
        base_debit: '1.2300',
        base_credit: '0',
        rate_reference: null,
        rate_effective_date: null,
        dimensions: [],
      },
    ],
    validation_state: errors.length ? 'invalid' : 'valid_for_draft',
    errors,
    rule_versions: [],
    audit_event_id: AUDIT,
    ledger_effect: 'none',
  };
}

describe('DraftsService minimal non-posting durable path (T051)', () => {
  function harness(result: Record<string, unknown> = upstream()) {
    const context = {
      resolve: jest.fn().mockResolvedValue({
        tenantId: TENANT,
        accountId: ACTOR,
        companyUuid: COMPANY,
        db: 'tenant_a',
        uid: 7,
        password: 'secret',
        companyId: 91,
      }),
    };
    const odoo = { executeKw: jest.fn().mockResolvedValue(result) };
    const handoff = {
      id: OPERATION,
      state: AccountingMutationHandoffState.PENDING,
      finalResponse: null,
      createdAt: new Date(),
      odooCommittedAt: null,
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
    const audit = { recordAccountingMutation: jest.fn(), recordPreDomainDenial: jest.fn() };
    return {
      service: new DraftsService(
        context as never,
        odoo as never,
        handoffs as never,
        audit as never,
      ),
      odoo,
      handoffs,
      audit,
    };
  }

  it('saves exact strings through guarded RPC, audits before success, and never touches account.move', async () => {
    const h = harness();
    await expect(h.service.save(request(), COMPANY, body())).resolves.toMatchObject({
      operationId: OPERATION,
      auditEventId: AUDIT,
      correlationId: 'corr-t051',
      replayed: false,
      ledgerEffect: 'none',
      resource: { id: DRAFT, companyId: COMPANY, status: 'draft', ledgerEffect: 'none' },
    });
    expect(h.odoo.executeKw).toHaveBeenCalledWith(
      'tenant_a',
      7,
      'secret',
      'kemfai.account.draft',
      'kemfai_save_minimal_draft',
      [OPERATION, FIXTURE_USER_ID, 91, body()],
      { context: { allowed_company_ids: [91], force_company: 91 } },
    );
    expect(JSON.stringify(h.odoo.executeKw.mock.calls)).not.toContain('account.move');
    expect(h.handoffs.markOdooCommitted).toHaveBeenCalledTimes(1);
    expect(h.audit.recordAccountingMutation).toHaveBeenCalledTimes(1);
    expect(h.handoffs.markAudited).toHaveBeenCalledTimes(1);
  });

  it('updates an existing draft with exact values, optimistic versioning, and stale validation invalidation', async () => {
    const updated = upstream() as ReturnType<typeof upstream>;
    updated.version = 2;
    updated.validation_state = 'stale';
    updated.lines[0].transaction_debit = '9.876500';
    updated.lines[0].base_debit = '36.2811375';
    const h = harness(updated);
    const changed = body();
    changed.lines[0].transactionDebit = '9.876500';
    changed.lines[0].baseDebit = '36.2811375';

    await expect(h.service.update(request(), COMPANY, DRAFT, 1, changed)).resolves.toMatchObject({
      operationId: OPERATION,
      ledgerEffect: 'none',
      resource: {
        id: DRAFT,
        version: 2,
        validationState: 'stale',
        lines: [{ transactionDebit: '9.876500', baseDebit: '36.2811375' }],
      },
    });
    expect(h.odoo.executeKw).toHaveBeenCalledWith(
      'tenant_a',
      7,
      'secret',
      'kemfai.account.draft',
      'kemfai_update_minimal_draft',
      [OPERATION, FIXTURE_USER_ID, DRAFT, 1, 91, changed],
      { context: { allowed_company_ids: [91], force_company: 91 } },
    );
  });

  it('returns precondition failed for a stale draft update without retrying stale input', async () => {
    const h = harness();
    h.odoo.executeKw.mockRejectedValueOnce(new Error('STALE_VERSION'));

    await expect(h.service.update(request(), COMPANY, DRAFT, 1, body())).rejects.toBeInstanceOf(
      PreconditionFailedException,
    );
    expect(h.handoffs.markRejected).toHaveBeenCalledWith(OPERATION, 'STALE_VERSION');
    expect(h.handoffs.scheduleRetryBackoff).not.toHaveBeenCalled();
  });

  it('lists only company-scoped drafts through the guarded paginated method', async () => {
    const h = harness({ items: [upstream()], next_cursor: DRAFT });

    await expect(
      h.service.list(request(['accounting.drafts.view']), COMPANY, {
        cursor: undefined,
        limit: 50,
      }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ id: DRAFT, companyId: COMPANY, ledgerEffect: 'none' })],
      nextCursor: DRAFT,
    });
    expect(h.odoo.executeKw).toHaveBeenCalledWith(
      'tenant_a',
      7,
      'secret',
      'kemfai.account.draft',
      'kemfai_list_minimal_drafts',
      [91, { cursor: undefined, limit: 50 }],
      { context: { allowed_company_ids: [91], force_company: 91 } },
    );
  });

  it('reads only through the guarded company-scoped draft method', async () => {
    const h = harness();
    await expect(
      h.service.get(request(['accounting.drafts.view']), COMPANY, DRAFT),
    ).resolves.toMatchObject({
      id: DRAFT,
      companyId: COMPANY,
      journalId: DRAFT,
      accountingDate: '2026-11-03',
      description: 'safe',
      ledgerEffect: 'none',
      lines: [
        {
          id: LINE,
          accountId: ACCOUNT,
          accountCode: '1100',
          transactionDebit: '1.2300',
          baseDebit: '1.2300',
        },
      ],
    });
    expect(h.odoo.executeKw).toHaveBeenCalledWith(
      'tenant_a',
      7,
      'secret',
      'kemfai.account.draft',
      'kemfai_read_minimal_draft',
      [DRAFT, 91],
      { context: { allowed_company_ids: [91], force_company: 91 } },
    );
  });

  it('round-trips normalized dimension labels and versions into validation snapshots', async () => {
    const result = upstream() as unknown as Record<string, unknown> & {
      lines: Array<{ dimensions: unknown[] }>;
      rule_versions: Array<Record<string, unknown>>;
    };
    result.lines[0].dimensions = [
      {
        definition_id: DEFINITION,
        value_id: VALUE,
        definition_name_en: 'Project',
        definition_name_ar: 'المشروع',
        value_name_en: 'Launch',
        value_name_ar: 'الإطلاق',
        definition_version: 3,
        value_version: 5,
        active: true,
      },
    ];
    result.rule_versions = [
      {
        rule_id: RULE,
        rule_version: 7,
        dimension_definition_id: DEFINITION,
        dimension_definition_version: 3,
        requirement: 'required',
      },
    ];
    const h = harness(result);

    await expect(h.service.save(request(), COMPANY, body())).resolves.toMatchObject({
      resource: {
        lines: [
          {
            dimensions: [
              {
                definitionId: DEFINITION,
                valueId: VALUE,
                definitionName: { en: 'Project', ar: 'المشروع' },
                valueName: { en: 'Launch', ar: 'الإطلاق' },
                active: true,
              },
            ],
          },
        ],
      },
    });

    const validation = harness(result);
    await expect(validation.service.validate(request(), COMPANY, DRAFT, 1)).resolves.toMatchObject({
      operationId: OPERATION,
      auditEventId: AUDIT,
      result: {
        configurationSnapshot: { dimensionRules: { [RULE]: 7 } },
      },
    });
  });

  it('returns receipt-bearing audited parent rejection from real validation RPC with no ledger call', async () => {
    const issue = {
      code: 'ACCOUNT_NOT_POSTING',
      message_key: 'account.notPosting',
      line_id: LINE,
      resource_id: ACCOUNT,
      field: 'accountId',
    };
    const h = harness(upstream([issue]));
    await expect(h.service.validate(request(), COMPANY, DRAFT, 1)).resolves.toMatchObject({
      operationId: OPERATION,
      auditEventId: AUDIT,
      ledgerEffect: 'none',
      result: { status: 'invalid', errors: [{ code: 'ACCOUNT_NOT_POSTING', lineId: LINE }] },
    });
    expect(h.odoo.executeKw).toHaveBeenCalledWith(
      'tenant_a',
      7,
      'secret',
      'kemfai.account.draft',
      'kemfai_validate_minimal_draft',
      [OPERATION, FIXTURE_USER_ID, DRAFT, 1, 91],
      { context: { allowed_company_ids: [91], force_company: 91 } },
    );
    expect(h.audit.recordAccountingMutation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.odoo.executeKw.mock.calls)).not.toContain('account.move');
  });

  it('fails closed on malformed upstream data', async () => {
    const h = harness({ id: DRAFT, ledger_effect: 'posted' });
    await expect(h.service.save(request(), COMPANY, body())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
