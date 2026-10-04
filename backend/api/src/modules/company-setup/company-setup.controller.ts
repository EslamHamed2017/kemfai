import { Controller, Get } from '@nestjs/common';
import { RequireFeatureFlag } from '../../common/decorators/feature-flag.decorator';
import { EnforceTrialWindow } from '../../common/decorators/trial-window.decorator';

interface CompanySetupState {
  currentStep: string;
  setupComplete: boolean;
  values: Record<string, unknown>;
}

/**
 * T042 (arbiter resolution, 2026-10-04): registers the real `GET /companies/current/setup`
 * route so the guard chain (TenantScopeGuard -> RoleGuard -> FeatureFlagGuard ->
 * TrialWindowGuard, app.module.ts) is exercised end to end, including a genuine
 * cross-tenant-denial audit assertion against this surface. `module.company_setup` ships
 * `enabled=false` (see the companion migration), so this stub stays hidden in every
 * environment until T054 lands the real step-save/resume/validation behavior and an owner
 * explicitly flips the flag. NO TASK ID -> NO IMPLEMENTATION: PUT /companies/current/setup
 * and POST /companies/current/setup/complete remain T054/T055's responsibility and are
 * intentionally absent here.
 */
@Controller('companies/current')
export class CompanySetupController {
  @Get('setup')
  @RequireFeatureFlag('module.company_setup')
  @EnforceTrialWindow()
  getSetup(): CompanySetupState {
    return { currentStep: 'country', setupComplete: false, values: {} };
  }
}
