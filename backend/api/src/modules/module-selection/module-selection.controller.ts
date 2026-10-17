import { Body, Controller, Get, HttpCode, HttpStatus, Put, Req } from '@nestjs/common';
import { RequireFeatureFlag } from '../../common/decorators/feature-flag.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { EnforceTrialWindow } from '../../common/decorators/trial-window.decorator';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { ModuleSelectionRequestDto } from './dto/module-selection.request.dto';
import {
  ModuleOption,
  ModuleSelectionResult,
  ModuleSelectionService,
} from './module-selection.service';

const MODULE_SELECTION_FEATURE = 'module.module_selection';

@Controller('modules')
@Roles('WorkspaceOwner')
@RequireFeatureFlag(MODULE_SELECTION_FEATURE)
@EnforceTrialWindow()
export class ModuleSelectionController {
  constructor(private readonly moduleSelection: ModuleSelectionService) {}

  @Get()
  list(@Req() req: TenantScopedRequest): Promise<ModuleOption[]> {
    return this.moduleSelection.list(req);
  }

  @Put('selection')
  @HttpCode(HttpStatus.OK)
  replace(
    @Req() req: TenantScopedRequest,
    @Body() body: ModuleSelectionRequestDto,
  ): Promise<ModuleSelectionResult> {
    return this.moduleSelection.replace(req, body.featureKeys);
  }
}
