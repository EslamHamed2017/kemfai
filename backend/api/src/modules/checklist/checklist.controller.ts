import { Controller, Get, Req } from '@nestjs/common';
import { RequireFeatureFlag } from '../../common/decorators/feature-flag.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { EnforceTrialWindow } from '../../common/decorators/trial-window.decorator';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { ChecklistService, ChecklistState } from './checklist.service';

@Controller('onboarding/checklist')
@Roles('WorkspaceOwner')
@RequireFeatureFlag('module.onboarding_checklist')
@EnforceTrialWindow()
export class ChecklistController {
  constructor(private readonly checklist: ChecklistService) {}

  @Get()
  get(@Req() req: TenantScopedRequest): Promise<ChecklistState> {
    return this.checklist.get(req);
  }
}
