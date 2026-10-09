import { IsIn, IsInt, IsObject, IsOptional, Min } from 'class-validator';

/**
 * Request body of `PUT /companies/current/setup` (contracts/openapi.yaml
 * "CompanySetupStepInput" + T054's `baseVersion` addition, arbiter resolution point 1).
 * `values` is intentionally loosely typed (`additionalProperties: true` in the contract):
 * the Odoo addon (`_kemfai_resolve_step_values`), not this DTO, is the single place that
 * knows which keys a given `step` accepts and whether each one is well-formed — runtime
 * validation here only guards the envelope shape itself.
 */
export class CompanySetupStepRequestDto {
  @IsIn([
    'country',
    'identity',
    'currency',
    'fiscal_year',
    'vat_tax',
    'industry',
    'accounting_setup',
  ])
  step!: string;

  @IsObject({ message: 'values must be an object' })
  values!: Record<string, unknown>;

  @IsOptional()
  @IsInt({ message: 'baseVersion must be an integer' })
  @Min(0, { message: 'baseVersion must not be negative' })
  baseVersion?: number;
}

/** Response body shape for both GET and PUT (contracts/openapi.yaml "CompanySetupState"). */
export interface CompanySetupStateDto {
  currentStep: string;
  setupComplete: boolean;
  values: Record<string, unknown>;
  version: number;
  stale: boolean;
  /** T056 — opaque server-authenticated tenant/account/company draft scope; see company-setup-scope.util.ts. */
  scope: string;
}
