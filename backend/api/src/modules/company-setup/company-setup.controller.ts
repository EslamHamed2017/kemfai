import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req } from '@nestjs/common';
import { RequireFeatureFlag } from '../../common/decorators/feature-flag.decorator';
import { EnforceTrialWindow } from '../../common/decorators/trial-window.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { CompanySetupService } from './company-setup.service';
import {
  CompanySetupStateDto,
  CompanySetupStepRequestDto,
} from './dto/company-setup-step.request.dto';

/**
 * T054: the real `GET`/`PUT /companies/current/setup` surface (contracts/openapi.yaml).
 * Guarded identically for the documented UI-shaped call and a raw HTTP replay — only
 * `WorkspaceOwner` may call this (`RoleGuard`, global `APP_GUARD`), only while
 * `module.company_setup` is enabled (`FeatureFlagGuard`) and the tenant's trial window has
 * not elapsed with auto-restriction resolved true (`TrialWindowGuard`) — both the latter
 * guards are also global `APP_GUARD`s that act purely on these decorators. All step-save/
 * resume/validation business logic lives in `CompanySetupService` and the
 * `kemfai_company_setup` Odoo addon; this controller is pure routing + guard wiring.
 */
@Controller('companies/current')
export class CompanySetupController {
  constructor(private readonly companySetup: CompanySetupService) {}

  @Get('setup')
  @Roles('WorkspaceOwner')
  @RequireFeatureFlag('module.company_setup')
  @EnforceTrialWindow()
  async getSetup(@Req() req: TenantScopedRequest): Promise<CompanySetupStateDto> {
    return this.companySetup.getState(req);
  }

  @Put('setup')
  @Roles('WorkspaceOwner')
  @RequireFeatureFlag('module.company_setup')
  @EnforceTrialWindow()
  async putSetup(
    @Req() req: TenantScopedRequest,
    @Body() body: CompanySetupStepRequestDto,
  ): Promise<CompanySetupStateDto> {
    return this.companySetup.saveStep(req, body);
  }

  /**
   * T055: finalizes the wizard once every required step is persisted (FR-028,
   * Acceptance Scenario 3.7). Guarded identically to GET/PUT above — only
   * `WorkspaceOwner`, only while `module.company_setup` is enabled, only within an
   * active trial/subscription window. Takes no request body: whether completion is
   * allowed is derived entirely from persisted `res.company` state inside
   * `CompanySetupService`/the Odoo addon, never from anything the caller sends.
   */
  @Post('setup/complete')
  @HttpCode(HttpStatus.OK)
  @Roles('WorkspaceOwner')
  @RequireFeatureFlag('module.company_setup')
  @EnforceTrialWindow()
  async completeSetup(@Req() req: TenantScopedRequest): Promise<CompanySetupStateDto> {
    return this.companySetup.completeSetup(req);
  }
}
