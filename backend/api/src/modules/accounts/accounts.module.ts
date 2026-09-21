import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { AuditModule } from '../audit/audit.module';
import { KeycloakModule } from '../../integrations/keycloak/keycloak.module';
import { QueuesModule } from '../../common/queues/queues.module';

@Module({
  imports: [AuditModule, KeycloakModule, QueuesModule],
  controllers: [AccountsController, MfaController],
  providers: [AccountsService, MfaService],
})
export class AccountsModule {}
