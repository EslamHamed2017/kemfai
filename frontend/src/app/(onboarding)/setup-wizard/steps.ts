/**
 * T056 — the fixed, seven-step order (Acceptance Scenario 3.1) and the field keys each
 * step owns. This mirrors `STEP_FIELDS`/`SETUP_WIZARD_STEPS` in
 * `backend/addons/kemfai_company_setup/models/company.py` structurally (same step ids,
 * same fields-per-step, same order) so the wizard sends exactly the keys the Odoo addon
 * expects — it does NOT duplicate any validation rule (format, required-ness, allowed
 * values): every one of those stays server-side and reaches the UI only as a classified
 * 422/409 (see `setup-wizard-error.ts`).
 */
export type FieldKind = 'text' | 'integer' | 'month-select' | 'template-select';

export interface StepField {
  key: string;
  kind: FieldKind;
}

export interface WizardStep {
  id: string;
  fields: StepField[];
}

export const WIZARD_STEPS: readonly WizardStep[] = [
  { id: 'country', fields: [{ key: 'country', kind: 'text' }] },
  {
    id: 'identity',
    fields: [
      { key: 'legal_name', kind: 'text' },
      { key: 'trade_name', kind: 'text' },
    ],
  },
  { id: 'currency', fields: [{ key: 'base_currency', kind: 'text' }] },
  {
    id: 'fiscal_year',
    fields: [
      { key: 'fiscal_year_start_month', kind: 'month-select' },
      { key: 'fiscal_year_start_day', kind: 'integer' },
    ],
  },
  { id: 'vat_tax', fields: [{ key: 'vat_tax_registration', kind: 'text' }] },
  { id: 'industry', fields: [{ key: 'industry', kind: 'integer' }] },
  { id: 'accounting_setup', fields: [{ key: 'accounting_setup_template', kind: 'template-select' }] },
] as const;

export const STEP_IDS: readonly string[] = WIZARD_STEPS.map((step) => step.id);

/** The sole value `ACCOUNTING_SETUP_TEMPLATES` currently offers server-side — not a
 * business decision made here; the UI simply needs one selectable option to submit. */
export const ACCOUNTING_SETUP_TEMPLATE_OPTIONS = ['standard'] as const;
