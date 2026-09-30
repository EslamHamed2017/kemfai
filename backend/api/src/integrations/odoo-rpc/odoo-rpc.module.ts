import { Module } from '@nestjs/common';
import { createOdooRpcClient } from './odoo-rpc-client';
import { OdooRpcService } from './odoo-rpc.service';

import { ODOO_RPC_CLIENT } from './odoo-rpc.token';
export { ODOO_RPC_CLIENT } from './odoo-rpc.token';

/**
 * T026's Nest wiring point. Feature modules (e.g. T044 tenant provisioning) import this
 * module and inject `OdooRpcService` rather than constructing an Odoo JSON-RPC client
 * themselves, so every Odoo call goes through the same audited, tenant-parameterised
 * code path (no shared/global session that could leak a previous tenant's db context).
 */
@Module({
  providers: [{ provide: ODOO_RPC_CLIENT, useFactory: createOdooRpcClient }, OdooRpcService],
  exports: [OdooRpcService],
})
export class OdooRpcModule {}
