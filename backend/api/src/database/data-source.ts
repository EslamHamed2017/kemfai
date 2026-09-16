import 'reflect-metadata';
import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';

/**
 * kemfai_control connection profile. This is the ONLY DataSource in the codebase that may name a
 * database: it is fixed to the control-plane database via env vars below. Tenant databases
 * (`kemfai_tenant_<id>`) are never reached through TypeORM/this DataSource — they are addressed
 * exclusively via the Odoo JSON-RPC client (backend/api/src/integrations/odoo-rpc/), so there is no
 * parameter or code path here that could redirect a query to a tenant database (Constitution
 * Principle IV).
 */
export const controlDataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.CONTROL_DB_HOST ?? 'localhost',
  port: Number(process.env.CONTROL_DB_PORT ?? 5432),
  username: process.env.CONTROL_DB_USER ?? 'kemfai',
  password: process.env.CONTROL_DB_PASSWORD ?? 'kemfai_dev_pg',
  database: process.env.CONTROL_DB_NAME ?? 'kemfai_control',
  entities: [join(__dirname, '..', 'modules', '**', 'entities', '*.entity.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  synchronize: false,
};

const controlDataSource = new DataSource(controlDataSourceOptions);

export default controlDataSource;
