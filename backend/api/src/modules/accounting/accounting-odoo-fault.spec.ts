import { deterministicAccountingFaultCode } from './accounting-odoo-fault';

describe('deterministicAccountingFaultCode', () => {
  it.each([
    'ACCOUNT_NOT_POSTING',
    'DRAFT_PAYLOAD_INVALID',
    'DRAFT_LINES_INVALID',
    'DRAFT_DECIMAL_INVALID',
    'DRAFT_DIMENSIONS_INVALID',
    'DIMENSION_RULE_INVALID',
    'JOURNAL_INACTIVE',
    'CURRENCY_DISABLED',
    'STALE_VERSION',
    'HISTORY_PROTECTED',
  ])('classifies immutable-request domain fault %s as terminal', (code) => {
    expect(deterministicAccountingFaultCode(new Error(`Odoo rejected: ${code}`))).toBe(code);
  });

  it.each(['ACCOUNT_AUDIT_TEST_FAULT', 'ACCOUNT_MUTATION_RECEIPT_WRITE_FAILED', 'ECONNRESET'])(
    'keeps infrastructure fault %s retryable',
    (code) => expect(deterministicAccountingFaultCode(new Error(code))).toBeNull(),
  );
});
