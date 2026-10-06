import { IsObject } from 'class-validator';

/**
 * Request body of `PUT /companies/current/settings` (contracts/openapi.yaml
 * "CompanySettingsInput", T055/FR-028). Loosely typed like
 * `CompanySetupStepRequestDto.values` for the same reason: the Odoo addon
 * (`_kemfai_resolve_step_values`, reused per-step by `kemfai_settings_update`) is the
 * single place that knows which keys are well-formed — this DTO only guards the envelope.
 */
export class CompanySettingsUpdateRequestDto {
  @IsObject({ message: 'values must be an object' })
  values!: Record<string, unknown>;
}

/** Response body shape for both GET and PUT (contracts/openapi.yaml "CompanySettingsView"). */
export interface CompanySettingsViewDto {
  values: Record<string, unknown>;
  setupComplete: boolean;
}
