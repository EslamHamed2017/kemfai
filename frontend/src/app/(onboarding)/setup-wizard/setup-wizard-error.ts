/**
 * T056 — classifies `GET`/`PUT /companies/current/setup` and
 * `POST /companies/current/setup/complete` failures by status AND payload, the same
 * doctrine as `(auth)/signup/signup-error.ts`: the BFF forwards the NestJS error body
 * unchanged (company-setup-bff.ts), and this module turns it into a specific,
 * localizable kind — never the server's raw (always-English) text, which would bypass
 * FR-014 localization in the Arabic locale.
 */
export type SetupWizardFieldErrorKind =
  | 'country'
  | 'legal_name'
  | 'trade_name'
  | 'base_currency'
  | 'fiscal_year_start_month'
  | 'fiscal_year_start_day'
  | 'vat_tax_registration'
  | 'industry'
  | 'accounting_setup_template';

export type SetupWizardErrorKind =
  | { kind: 'field'; field: SetupWizardFieldErrorKind }
  | { kind: 'configGap' }
  | { kind: 'incompleteSteps' }
  | { kind: 'forbiddenRole' }
  | { kind: 'trialExpired' }
  | { kind: 'featureUnavailable' }
  | { kind: 'sessionExpired' }
  | { kind: 'scopeMismatch' }
  | { kind: 'offline' }
  | { kind: 'unexpected' };

function normalizeMessage(message: unknown): string {
  if (Array.isArray(message)) return message.join(' ');
  return typeof message === 'string' ? message : '';
}

function fieldFromMessage(text: string): SetupWizardFieldErrorKind | null {
  if (text.includes('vat_tax_registration')) return 'vat_tax_registration';
  if (text.includes('fiscal_year_start_day')) return 'fiscal_year_start_day';
  if (text.includes('fiscal_year_start_month')) return 'fiscal_year_start_month';
  if (text.includes('accounting_setup_template')) return 'accounting_setup_template';
  if (text.includes('legal_name')) return 'legal_name';
  if (text.includes('trade_name')) return 'trade_name';
  if (text.includes('currency')) return 'base_currency';
  if (text.includes('industry')) return 'industry';
  if (text.includes('country')) return 'country';
  return null;
}

export function classifySetupWizardError(status: number, message: unknown): SetupWizardErrorKind {
  const text = normalizeMessage(message);

  if (status === 401) return { kind: 'sessionExpired' };
  if (status === 404) return { kind: 'featureUnavailable' };
  if (status === 403) {
    return text.toLowerCase().includes('trial') ? { kind: 'trialExpired' } : { kind: 'forbiddenRole' };
  }
  if (status === 409) return { kind: 'configGap' };
  // T056 binding-review point 1 — the server rejected the X-KEMFAI-Setup-Scope
  // precondition: a session/account transition happened and the stale scope must never
  // be treated as a retryable general error. The caller quarantines the draft and
  // reloads authoritative state for whichever account is actually authenticated now.
  if (status === 412) return { kind: 'scopeMismatch' };
  if (status === 422) {
    if (text.includes('required step')) return { kind: 'incompleteSteps' };
    const field = fieldFromMessage(text);
    if (field) return { kind: 'field', field };
    return { kind: 'unexpected' };
  }
  return { kind: 'unexpected' };
}
