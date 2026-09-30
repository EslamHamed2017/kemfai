import { Module } from '@nestjs/common';
import { KeycloakModule } from '../keycloak/keycloak.module';
import { QueuesModule } from '../../common/queues/queues.module';
import { AuditModule } from '../../modules/audit/audit.module';
import { MinioModule } from '../minio/minio.module';
import { OdooRpcModule } from '../odoo-rpc/odoo-rpc.module';
import { TenantProvisionProcessor } from './tenant-provision.processor';
@Module({
  imports: [KeycloakModule, QueuesModule, AuditModule, MinioModule, OdooRpcModule],
  providers: [TenantProvisionProcessor],
})
export class TenantProvisionModule {}
