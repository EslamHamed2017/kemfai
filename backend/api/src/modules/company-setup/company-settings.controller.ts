import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { RequireFeatureFlag } from '../../common/decorators/feature-flag.decorator';
import { EnforceTrialWindow } from '../../common/decorators/trial-window.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { CompanySettingsService } from './company-settings.service';
import {
  CompanySettingsUpdateRequestDto,
  CompanySettingsViewDto,
} from './dto/company-settings.request.dto';

/**
 * T055/FR-028: `GET`/`PUT /companies/current/settings` — the post-completion surface
 * that lets required setup values stay editable "not by re-running the wizard as the
 * only path" (FR-028). Guarded identically to `CompanySetupController` (only
 * `WorkspaceOwner`, only while `module.company_setup` is enabled, only within an active
 * trial/subscription window) — plus the service layer's own 409 when
 * `Company.setup_complete` is not yet true, since this surface must never be reachable
 * before the wizard actually finishes.
 */
@Controller('companies/current')
export class CompanySettingsController {
  constructor(private readonly companySettings: CompanySettingsService) {}

  @Get('settings')
  @Roles('WorkspaceOwner')
  @RequireFeatureFlag('module.company_setup')
  @EnforceTrialWindow()
  async getSettings(@Req() req: TenantScopedRequest): Promise<CompanySettingsViewDto> {
    return this.companySettings.getSettings(req);
  }

  @Put('settings')
  @Roles('WorkspaceOwner')
  @RequireFeatureFlag('module.company_setup')
  @EnforceTrialWindow()
  async putSettings(
    @Req() req: TenantScopedRequest,
    @Body() body: CompanySettingsUpdateRequestDto,
  ): Promise<CompanySettingsViewDto> {
    return this.companySettings.updateSettings(req, body);
  }
}
