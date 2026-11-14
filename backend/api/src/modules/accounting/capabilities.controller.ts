import { Controller, Get, Headers, Req } from '@nestjs/common';
import { RequireFeatureFlag } from '../../common/decorators/feature-flag.decorator';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { AccountingOdooContextService } from './accounting-odoo-context.service';

export interface AccountingCapabilities {
  foundationEnabled: true;
  draftsEnabled: true;
  postingEnabled: false;
  reversalEnabled: false;
  openingPostingEnabled: false;
  periodEnforcementEnabled: false;
  policyGate: 'OWNER_APPROVAL_REQUIRED';
}

const POLICY_SAFE_CAPABILITIES: Readonly<AccountingCapabilities> = Object.freeze({
  foundationEnabled: true,
  draftsEnabled: true,
  postingEnabled: false,
  reversalEnabled: false,
  openingPostingEnabled: false,
  periodEnforcementEnabled: false,
  policyGate: 'OWNER_APPROVAL_REQUIRED',
});

@Controller('v1/accounting/capabilities')
@RequireFeatureFlag('module.accounting_foundation')
export class AccountingCapabilitiesController {
  constructor(private readonly context: AccountingOdooContextService) {}

  @Get()
  async get(
    @Req() req: TenantScopedRequest,
    @Headers('x-kemfai-company-id') companyId: string,
  ): Promise<AccountingCapabilities> {
    await this.context.resolve(req, companyId);
    return POLICY_SAFE_CAPABILITIES;
  }
}
