const STRING_VALUE_KEYS = new Set([
  'country',
  'legal_name',
  'trade_name',
  'base_currency',
  'vat_tax_registration',
  'accounting_setup_template',
]);

const PUBLIC_COMPANY_KEYS = new Set([
  ...STRING_VALUE_KEYS,
  'fiscal_year_start_month',
  'fiscal_year_start_day',
  'industry',
]);

/**
 * Checks the exact projection returned by the private company model.  The projection may
 * be partial in a stored recovery receipt, but arbitrary model/RPC keys are never public.
 */
export function isPublicCompanyValues(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  return Object.entries(value).every(([key, item]) => {
    if (!PUBLIC_COMPANY_KEYS.has(key)) return false;
    if (item === false) return true;
    if (STRING_VALUE_KEYS.has(key)) return typeof item === 'string';
    if (key === 'fiscal_year_start_month') {
      return typeof item === 'string' && /^(?:[1-9]|1[0-2])$/.test(item);
    }
    if (key === 'fiscal_year_start_day') {
      return Number.isInteger(item) && (item as number) >= 1 && (item as number) <= 31;
    }
    return key === 'industry' && Number.isInteger(item) && (item as number) > 0;
  });
}

export function isPublicCompanyField(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_COMPANY_KEYS.has(value);
}
