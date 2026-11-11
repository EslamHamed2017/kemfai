import { Module } from '@nestjs/common';
import { TenantContextModule } from '../../common/tenant-context/tenant-context.module';
import { OdooRpcModule } from '../../integrations/odoo-rpc/odoo-rpc.module';
import { AuditModule } from '../audit/audit.module';
import { AccountingMutationHandoffService } from './accounting-mutation-handoff.service';
import { AccountingOdooContextService } from './accounting-odoo-context.service';
import { AccountingPlatformAuditService } from './accounting-platform-audit.service';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsService } from './accounts/accounts.service';
import { AccountingCapabilitiesController } from './capabilities.controller';
import { DraftValidationService } from './drafts/draft-validation.service';
import { DraftsController } from './drafts/drafts.controller';
import { DraftsService } from './drafts/drafts.service';
import {
  DimensionDefinitionsController,
  DimensionRulesController,
  DimensionValuesController,
} from './dimensions/dimensions.controller';
import { DimensionsService } from './dimensions/dimensions.service';
import { JournalsCurrenciesController } from './journals-currencies/journals-currencies.controller';
import { JournalsCurrenciesService } from './journals-currencies/journals-currencies.service';

/**
 * Policy-independent accounting foundation only. Posting, policy, reversal, opening-balance,
 * and period-control providers deliberately do not belong in this module while the Accounting
 * Policy Matrix is pending owner approval.
 *
 * AccountingMutationHandoff is discovered by the control-plane DataSource entity glob; tenant
 * accounting records remain exclusively behind the routed Odoo RPC boundary.
 */
@Module({
  imports: [TenantContextModule, OdooRpcModule, AuditModule],
  controllers: [
    AccountingCapabilitiesController,
    AccountsController,
    DraftsController,
    DimensionDefinitionsController,
    DimensionValuesController,
    DimensionRulesController,
    JournalsCurrenciesController,
  ],
  providers: [
    AccountingMutationHandoffService,
    AccountingOdooContextService,
    AccountingPlatformAuditService,
    AccountsService,
    DraftsService,
    DimensionsService,
    JournalsCurrenciesService,
    DraftValidationService,
  ],
})
export class AccountingModule {}
