import {
  PreconditionFailedException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AccountingMutationHandoffState } from '../entities/accounting-mutation-handoff.entity';
import { DraftValidationService } from './draft-validation.service';

const TENANT = '51515151-1111-4111-8111-111111111111',
  ACTOR = '51515151-2222-4222-8222-222222222222';
const COMPANY = '51515151-3333-4333-8333-333333333333',
  OPERATION = '51515151-4444-4444-8444-444444444444';
const DRAFT = '51515151-5555-4555-8555-555555555555',
  RUN = '51515151-6666-4666-8666-666666666666';
const AUDIT = '51515151-7777-4777-8777-777777777777',
  JOURNAL = '51515151-8888-4888-8888-888888888888';
const ACCOUNT = '51515151-9999-4999-8999-999999999999',
  CURRENCY = '52525252-1111-4111-8111-111111111111';
const upstream = {
  id: DRAFT,
  company_id: 91,
  version: 4,
  status: 'draft',
  journal_id: JOURNAL,
  accounting_date: '2026-11-07',
  description: 'validate',
  transaction_type: 'manual_journal',
  lines: [],
  validation_state: 'valid_for_draft',
  errors: [],
  rule_versions: [],
  ledger_effect: 'none',
  validation_run_id: RUN,
  checks_performed: ['base_arithmetic'],
  warnings: [],
  policy_blockers: [],
  base_debit_total: '10.2300',
  base_credit_total: '10.2300',
  company_base_currency_code: 'AED',
  base_precision: 2,
  validated_at: '2026-11-07T16:00:00Z',
  audit_event_id: AUDIT,
  configuration_versions: [
    { kind: 'account', resource_id: ACCOUNT, snapshot_version: 3, current_version: 3 },
    { kind: 'journal', resource_id: JOURNAL, snapshot_version: 2, current_version: 2 },
    {
      kind: 'currency',
      configuration_id: CURRENCY,
      configuration_version: 5,
      current_configuration_version: 5,
      currency_code: 'USD',
      native_metadata_version: 'usd-v1',
      native_decimal_places: 2,
    },
  ],
};
function request() {
  return {
    headers: { 'idempotency-key': 'validate-one', 'x-correlation-id': 'corr-128' },
    auth: { keycloakUserId: 'keycloak-user', roles: ['accounting.drafts.edit'] },
  } as never;
}
function harness(state = AccountingMutationHandoffState.PENDING) {
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
  const odoo = { executeKw: jest.fn().mockResolvedValue(upstream) };
  const row = {
    id: OPERATION,
    state,
    finalResponse: state === AccountingMutationHandoffState.AUDITED ? upstream : null,
    lastErrorCode: state === AccountingMutationHandoffState.REJECTED ? 'ACCOUNT_NOT_POSTING' : null,
    odooCommittedAt: null,
    action: 'draft.validate',
  };
  const handoffs = {
    findOrCreateHandoff: jest.fn().mockResolvedValue(row),
    markOdooCommitted: jest.fn(),
    markRejected: jest.fn(),
    markAudited: jest.fn(),
    scheduleRetryBackoff: jest.fn(),
  };
  const audit = { recordAccountingMutation: jest.fn(), recordPreDomainDenial: jest.fn() };
  return {
    service: new DraftValidationService(
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
describe('DraftValidationService immutable orchestration (T128)', () => {
  it('returns the authoritative immutable run, exact totals, snapshots, and receipt', async () => {
    const h = harness();
    await expect(h.service.validate(request(), COMPANY, DRAFT, 4)).resolves.toEqual({
      operationId: OPERATION,
      auditEventId: AUDIT,
      correlationId: 'corr-128',
      replayed: false,
      ledgerEffect: 'none',
      result: {
        id: RUN,
        draftId: DRAFT,
        draftVersion: 4,
        status: 'valid_for_draft',
        ledgerEffect: 'none',
        checksPerformed: ['base_arithmetic'],
        errors: [],
        warnings: [],
        policyBlockers: [],
        companyBaseCurrencyCode: 'AED',
        basePrecision: 2,
        baseDebitTotal: '10.2300',
        baseCreditTotal: '10.2300',
        validatedAt: '2026-11-07T16:00:00Z',
        configurationSnapshot: {
          accounts: { [ACCOUNT]: 3 },
          dimensionRules: {},
          journal: { id: JOURNAL, version: 2 },
          currencies: {
            USD: {
              currencyCode: 'USD',
              configurationVersion: 5,
              nativeMetadataVersion: 'usd-v1',
              nativeDecimalPlaces: 2,
            },
          },
        },
      },
    });
    expect(h.handoffs.markOdooCommitted).toHaveBeenCalledWith(OPERATION, upstream);
    expect(h.audit.recordAccountingMutation).toHaveBeenCalledTimes(1);
    expect(h.handoffs.markAudited).toHaveBeenCalledWith(OPERATION);
  });
  it('replays one immutable tenant result without a second RPC or audit', async () => {
    const h = harness(AccountingMutationHandoffState.AUDITED);
    await expect(h.service.validate(request(), COMPANY, DRAFT, 4)).resolves.toMatchObject({
      operationId: OPERATION,
      auditEventId: AUDIT,
      replayed: true,
      result: { id: RUN },
    });
    expect(h.odoo.executeKw).not.toHaveBeenCalled();
    expect(h.audit.recordAccountingMutation).not.toHaveBeenCalled();
  });
  it('terminally rejects stale validation without scheduling recovery', async () => {
    const h = harness();
    h.odoo.executeKw.mockRejectedValueOnce(new Error('STALE_VERSION'));

    await expect(h.service.validate(request(), COMPANY, DRAFT, 4)).rejects.toBeInstanceOf(
      PreconditionFailedException,
    );
    expect(h.handoffs.markRejected).toHaveBeenCalledWith(OPERATION, 'STALE_VERSION');
    expect(h.handoffs.scheduleRetryBackoff).not.toHaveBeenCalled();
  });

  it('terminally rejects account validation faults and replays the rejection without Odoo', async () => {
    const first = harness();
    first.odoo.executeKw.mockRejectedValueOnce(new Error('ACCOUNT_NOT_POSTING'));
    await expect(first.service.validate(request(), COMPANY, DRAFT, 4)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(first.handoffs.markRejected).toHaveBeenCalledWith(OPERATION, 'ACCOUNT_NOT_POSTING');
    expect(first.handoffs.scheduleRetryBackoff).not.toHaveBeenCalled();

    const replay = harness(AccountingMutationHandoffState.REJECTED);
    await expect(replay.service.validate(request(), COMPANY, DRAFT, 4)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(replay.odoo.executeKw).not.toHaveBeenCalled();
    expect(replay.handoffs.scheduleRetryBackoff).not.toHaveBeenCalled();
  });

  it('withholds success and schedules recovery when the platform audit mirror fails', async () => {
    const h = harness();
    h.audit.recordAccountingMutation.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(h.service.validate(request(), COMPANY, DRAFT, 4)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(h.handoffs.markAudited).not.toHaveBeenCalled();
    expect(h.handoffs.scheduleRetryBackoff).toHaveBeenCalledWith(OPERATION, 1000);
  });
});
