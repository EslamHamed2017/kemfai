const DETERMINISTIC_ACCOUNTING_CODE =
  /^(?:STALE_VERSION|PRECONDITION_FAILED|HISTORY_PROTECTED|ACCOUNT_[A-Z0-9_]+|DRAFT_[A-Z0-9_]+|DIMENSION_[A-Z0-9_]+|JOURNAL_[A-Z0-9_]+|CURRENCY_[A-Z0-9_]+|NATIVE_[A-Z0-9_]+|BASE_CURRENCY_[A-Z0-9_]+)$/;
const RETRYABLE_ACCOUNTING_CODE = /^(?:ACCOUNT_AUDIT_|ACCOUNT_MUTATION_RECEIPT_)/;
const CODE_TOKEN = /\b[A-Z][A-Z0-9_]+\b/g;

/** Extract a stable domain rejection code; infrastructure/transport faults remain retryable. */
export function deterministicAccountingFaultCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  for (const code of message.match(CODE_TOKEN) ?? []) {
    if (RETRYABLE_ACCOUNTING_CODE.test(code)) continue;
    if (DETERMINISTIC_ACCOUNTING_CODE.test(code)) return code;
  }
  return null;
}
