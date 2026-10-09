import { Injectable, InternalServerErrorException } from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { Tenant } from '../tenants/entities/tenant.entity';
import { TenantContextResolver } from '../../common/tenant-context/tenant-context.resolver';
import {
  TenantContext,
  TenantScopedRequest,
} from '../../common/tenant-context/tenant-context.model';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { provisioningCredentials } from '../../integrations/provisioning/credentials';

export interface TenantOdooCompanyContext {
  db: string;
  uid: number;
  password: string;
  companyId: number;
}

/**
 * Shared tenant -> Odoo-company resolution (extracted from T054's
 * `company-setup.service.ts` so T055's `company-settings.service.ts` can reuse the exact
 * same resolution instead of duplicating it): resolves the caller's tenant (never a
 * client-supplied tenant id — TenantContextResolver, the same source TenantScopeGuard
 * already used for this request), loads that tenant's Odoo database name, and finds its
 * single `res.company` record. Behavior is unchanged from the original private method.
 */
@Injectable()
export class CompanyOdooContextService {
  constructor(
    private readonly tenantContextResolver: TenantContextResolver,
    private readonly odoo: OdooRpcService,
  ) {}

  /** Exposes the memoized TenantContext (accountId/callerTenantId) for audit-event authorship. */
  async resolveTenantContext(req: TenantScopedRequest): Promise<TenantContext> {
    return this.tenantContextResolver.resolveForRequest(req);
  }

  async resolve(req: TenantScopedRequest): Promise<TenantOdooCompanyContext> {
    const tenantContext = await this.tenantContextResolver.resolveForRequest(req);
    if (!tenantContext.callerTenantId) {
      throw new InternalServerErrorException('No tenant resolved for this request');
    }
    return this.resolveByTenantId(tenantContext.callerTenantId);
  }

  /**
   * T056 round-5 binding resolution (item 1) — control-plane-ONLY lookup of the caller's
   * immutable Odoo company target. Reads `Tenant.odooCompanyId` (captured once by
   * `TenantProvisionProcessor.verifyCompany` at provisioning time) from Postgres and never
   * touches Odoo — so `CompanySetupService` can compute/validate the expected
   * `X-KEMFAI-Setup-Scope` BEFORE any `authenticate`/`search`/mutation RPC runs, closing the
   * gap where a missing/blank/mismatched scope was previously only caught after `resolve()`
   * had already hit Odoo to learn the company id.
   */
  async resolveCompanyTarget(tenantId: string): Promise<number> {
    const tenant = await controlDataSource.getRepository(Tenant).findOneBy({ id: tenantId });
    if (!tenant?.odooCompanyId) {
      throw new InternalServerErrorException('Tenant has no provisioned Odoo company');
    }
    return tenant.odooCompanyId;
  }

  /**
   * T056 round-5 binding resolution (item 1) — resolves ONLY the Odoo credentials
   * (database name + authenticated uid/password), deliberately split from
   * `resolveCompanyTarget` above: this is the first point in a request's lifecycle that is
   * allowed to call `odoo.authenticate`, and callers must invoke it only AFTER the scope/
   * principal preconditions have already passed.
   */
  async resolveCredentials(
    tenantId: string,
  ): Promise<{ db: string; uid: number; password: string }> {
    const tenant = await controlDataSource.getRepository(Tenant).findOneBy({ id: tenantId });
    if (!tenant?.odooDbName) {
      throw new InternalServerErrorException('Tenant has no provisioned Odoo database');
    }
    const { login, password } = provisioningCredentials();
    const uid = await this.odoo.authenticate(tenant.odooDbName, login, password);
    return { db: tenant.odooDbName, uid, password };
  }

  /**
   * T055 — `CompanyMutationRecoveryWorker` has no inbound HTTP request to resolve a
   * tenant from (recovery runs autonomously, never triggered by a client call), so it
   * resolves Odoo credentials directly from a handoff's persisted `tenantId`. This reuses
   * the SAME `provisioningCredentials()` tenant-credential resolver `resolve()` above
   * uses — never a raw JWT/Odoo password read back out of the handoff row, which stores
   * neither (arbiter resolution: "reuse secure existing tenant credential resolver
   * internally for recovery").
   */
  async resolveByTenantId(tenantId: string): Promise<TenantOdooCompanyContext> {
    const tenant = await controlDataSource.getRepository(Tenant).findOneBy({ id: tenantId });
    if (!tenant?.odooDbName) {
      throw new InternalServerErrorException('Tenant has no provisioned Odoo database');
    }
    const { login, password } = provisioningCredentials();
    const uid = await this.odoo.authenticate(tenant.odooDbName, login, password);
    const companyRows = (await this.odoo.executeKw(
      tenant.odooDbName,
      uid,
      password,
      'res.company',
      'search',
      [[]],
      { limit: 1 },
    )) as number[];
    const companyId = companyRows[0];
    if (!companyId) {
      throw new InternalServerErrorException('Tenant database has no company record');
    }
    return { db: tenant.odooDbName, uid, password, companyId };
  }
}
