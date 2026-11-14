import { PreconditionFailedException } from '@nestjs/common';
import { TenantScopedRequest } from '../../../common/tenant-context/tenant-context.model';
import { AccountingMutationHandoffState } from '../entities/accounting-mutation-handoff.entity';
import { JournalsCurrenciesService } from './journals-currencies.service';

const COMPANY_UUID = '11111111-1111-4111-8111-111111111111';
const JOURNAL_UUID = '22222222-2222-4222-8222-222222222222';
const OPERATION_UUID = '33333333-3333-4333-8333-333333333333';
const AUDIT_UUID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_UUID = '55555555-5555-4555-8555-555555555555';

function request(): TenantScopedRequest {
  return {
    auth: {
      keycloakUserId: 'user-a',
      roles: ['accounting.coa.view', 'accounting.coa.create', 'accounting.coa.edit'],
    },
    headers: {
      'idempotency-key': 'journal-key',
      'x-correlation-id': CORRELATION_UUID,
    },
  } as unknown as TenantScopedRequest;
}

function upstream(version = 1) {
  return {
    id: JOURNAL_UUID,
    company_id: COMPANY_UUID,
    code: 'GJ',
    name_en: 'General Journal',
    name_ar: 'دفتر اليومية العام',
    type: 'general',
    active: true,
    version,
    audit_event_id: AUDIT_UUID,
  };
}

function currencyUpstream(version = 1) {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    company_id: COMPANY_UUID,
    currency_code: 'AED',
    native_decimal_places: 2,
    native_metadata_version: 'aed:2:v1',
    is_base: false,
    enabled: true,
    version,
    audit_event_id: AUDIT_UUID,
  };
}

function fixture() {
  const context = {
    resolve: jest.fn().mockResolvedValue({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      companyUuid: COMPANY_UUID,
      db: 'tenant_a',
      uid: 7,
      password: 'not-serialized',
      companyId: 3,
    }),
  };
  const odoo = { executeKw: jest.fn() };
  const handoffs = {
    findOrCreateHandoff: jest.fn(),
    markOdooCommitted: jest.fn().mockResolvedValue(undefined),
    markRejected: jest.fn().mockResolvedValue(undefined),
    markAudited: jest.fn().mockResolvedValue(undefined),
    scheduleRetryBackoff: jest.fn().mockResolvedValue(undefined),
  };
  const audit = {
    recordAccountingMutation: jest.fn().mockResolvedValue(undefined),
    recordPreDomainDenial: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new JournalsCurrenciesService(
      context as never,
      odoo as never,
      handoffs as never,
      audit as never,
    ),
    context,
    odoo,
    handoffs,
    audit,
  };
}

describe('JournalsCurrenciesService journal boundary (T123)', () => {
  it('lists company-scoped general journals through the guarded RPC method', async () => {
    const { service, odoo } = fixture();
    odoo.executeKw.mockResolvedValue({ items: [upstream()] });

    await expect(service.listJournals(request(), COMPANY_UUID, { active: true })).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: JOURNAL_UUID,
          companyId: COMPANY_UUID,
          journalType: 'general',
          selectableForDrafts: true,
        }),
      ],
      nextCursor: null,
    });
    expect(odoo.executeKw).toHaveBeenCalledWith(
      'tenant_a',
      7,
      'not-serialized',
      'account.journal',
      'kemfai_list_journals',
      [3, { active: true }],
      { context: { allowed_company_ids: [3], force_company: 3 } },
    );
  });

  it('creates a receipt-bearing journal and converges the platform audit', async () => {
    const { service, odoo, handoffs, audit } = fixture();
    handoffs.findOrCreateHandoff.mockResolvedValue({
      id: OPERATION_UUID,
      state: AccountingMutationHandoffState.PENDING,
      odooCommittedAt: null,
      finalResponse: null,
      action: 'journal.create',
    });
    odoo.executeKw.mockResolvedValue(upstream());

    await expect(
      service.createJournal(request(), COMPANY_UUID, {
        code: 'GJ',
        name: { en: 'General Journal', ar: 'دفتر اليومية العام' },
        journalType: 'general',
        active: true,
      }),
    ).resolves.toEqual({
      operationId: OPERATION_UUID,
      auditEventId: AUDIT_UUID,
      correlationId: CORRELATION_UUID,
      replayed: false,
      resource: expect.objectContaining({ id: JOURNAL_UUID, version: 1 }),
    });
    expect(odoo.executeKw).toHaveBeenCalledWith(
      'tenant_a',
      7,
      'not-serialized',
      'account.journal',
      'kemfai_create_journal',
      [OPERATION_UUID, 'user-a', expect.objectContaining({ company_id: 3, type: 'general' })],
      { context: { allowed_company_ids: [3], force_company: 3 } },
    );
    expect(handoffs.markOdooCommitted).toHaveBeenCalledWith(OPERATION_UUID, upstream());
    expect(audit.recordAccountingMutation).toHaveBeenCalledTimes(1);
    expect(handoffs.markAudited).toHaveBeenCalledWith(OPERATION_UUID);
  });

  it('maps stale journal updates to HTTP 412 without scheduling an unknown retry', async () => {
    const { service, odoo, handoffs } = fixture();
    handoffs.findOrCreateHandoff.mockResolvedValue({
      id: OPERATION_UUID,
      state: AccountingMutationHandoffState.PENDING,
      finalResponse: null,
      action: 'journal.update',
    });
    odoo.executeKw.mockRejectedValue(new Error('STALE_VERSION'));

    await expect(
      service.updateJournal(request(), COMPANY_UUID, JOURNAL_UUID, 1, {
        name: { en: 'Changed', ar: 'معدل' },
      }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
    expect(handoffs.markRejected).toHaveBeenCalledWith(OPERATION_UUID, 'STALE_VERSION');
    expect(handoffs.scheduleRetryBackoff).not.toHaveBeenCalled();
  });

  it('lists immutable native currency metadata through the guarded RPC method', async () => {
    const { service, odoo } = fixture();
    odoo.executeKw.mockResolvedValue({ items: [currencyUpstream()] });

    await expect(
      service.listCurrencies(request(), COMPANY_UUID, { enabled: true }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          currencyCode: 'AED',
          nativeDecimalPlaces: 2,
          nativeMetadataVersion: 'aed:2:v1',
          isBase: false,
          enabled: true,
        }),
      ],
      nextCursor: null,
    });
    expect(odoo.executeKw).toHaveBeenCalledWith(
      'tenant_a',
      7,
      'not-serialized',
      'kemfai.account.currency.config',
      'kemfai_list_currency_configurations',
      [3, { enabled: true }],
      { context: { allowed_company_ids: [3], force_company: 3 } },
    );
  });

  it('puts create-only currency enablement with an immutable receipt', async () => {
    const { service, odoo, handoffs, audit } = fixture();
    handoffs.findOrCreateHandoff.mockResolvedValue({
      id: OPERATION_UUID,
      state: AccountingMutationHandoffState.PENDING,
      odooCommittedAt: null,
      finalResponse: null,
      action: 'currency.put',
    });
    odoo.executeKw.mockResolvedValue(currencyUpstream());

    await expect(
      service.putCurrencyConfiguration(request(), COMPANY_UUID, 'AED', '*', { enabled: true }),
    ).resolves.toEqual({
      operationId: OPERATION_UUID,
      auditEventId: AUDIT_UUID,
      correlationId: CORRELATION_UUID,
      replayed: false,
      resource: expect.objectContaining({ currencyCode: 'AED', enabled: true, version: 1 }),
    });
    expect(odoo.executeKw).toHaveBeenCalledWith(
      'tenant_a',
      7,
      'not-serialized',
      'kemfai.account.currency.config',
      'kemfai_put_currency_configuration',
      [3, 'AED', OPERATION_UUID, 'user-a', '*', { enabled: true }],
      { context: { allowed_company_ids: [3], force_company: 3 } },
    );
    expect(audit.recordAccountingMutation).toHaveBeenCalledTimes(1);
    expect(handoffs.markAudited).toHaveBeenCalledWith(OPERATION_UUID);
  });

  it('maps currency precondition failures to HTTP 412 without retry scheduling', async () => {
    const { service, odoo, handoffs } = fixture();
    handoffs.findOrCreateHandoff.mockResolvedValue({
      id: OPERATION_UUID,
      state: AccountingMutationHandoffState.PENDING,
      finalResponse: null,
      action: 'currency.put',
    });
    odoo.executeKw.mockRejectedValue(new Error('PRECONDITION_FAILED'));

    await expect(
      service.putCurrencyConfiguration(request(), COMPANY_UUID, 'AED', '"1"', { enabled: false }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
    expect(handoffs.scheduleRetryBackoff).not.toHaveBeenCalled();
  });
});
