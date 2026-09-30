import { Inject, Injectable } from '@nestjs/common';
import { ODOO_RPC_CLIENT } from './odoo-rpc.token';
import type { OdooRpcClientLike } from './odoo-rpc-client';

/**
 * T026's connection wrapper: one JSON-RPC session per call, opened against whichever
 * `kemfai_tenant_<id>` database is passed in. Every method takes `database` (and, where
 * relevant, `uid`) as an explicit call-time parameter rather than storing it on `this` -
 * this service holds zero session/tenant state between calls, so authenticating against
 * `kemfai_tenant_a` and then `kemfai_tenant_b` (or interleaved, concurrently) never lets
 * one tenant's db context leak into another tenant's request.
 */
@Injectable()
export class OdooRpcService {
  constructor(@Inject(ODOO_RPC_CLIENT) private readonly client: OdooRpcClientLike) {}

  async databaseList(): Promise<string[]> {
    const result = await this.client.call('db', 'list', []);
    if (!Array.isArray(result) || result.some((item) => typeof item !== 'string'))
      throw new Error('Invalid Odoo database list');
    return result as string[];
  }

  async createDatabase(
    master: string,
    database: string,
    login: string,
    password: string,
  ): Promise<void> {
    const result = await this.client.call('db', 'create_database', [
      master,
      database,
      false,
      'en_US',
      password,
      login,
    ]);
    if (result !== true) throw new Error('Odoo database creation failed');
  }

  async authenticate(database: string, login: string, password: string): Promise<number> {
    const uid = await this.client.call('common', 'login', [database, login, password]);
    if (typeof uid !== 'number') {
      throw new Error(`Odoo authentication failed for database "${database}"`);
    }
    return uid;
  }

  async executeKw(
    database: string,
    uid: number,
    password: string,
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.client.call('object', 'execute_kw', [
      database,
      uid,
      password,
      model,
      method,
      args,
      kwargs,
    ]);
  }
}
