import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { Tenant } from '../tenants/entities/tenant.entity';
import { TenantContextResolver } from '../../common/tenant-context/tenant-context.resolver';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { provisioningCredentials } from '../../integrations/provisioning/credentials';
import {
  CompanySetupStateDto,
  CompanySetupStepRequestDto,
} from './dto/company-setup-step.request.dto';

interface OdooCompanySetupState {
  currentStep: string;
  setupComplete: boolean;
  values: Record<string, unknown>;
  version: number;
  stale: boolean;
}

/**
 * GET/PUT `/companies/current/setup` (T054). Every call resolves the caller's tenant
 * (never a client-supplied tenant id — TenantContextResolver, same source TenantScopeGuard
 * already used for this request), loads that tenant's Odoo database name, and reaches the
 * `res.company` RPC surface added in `backend/addons/kemfai_company_setup/models/company.py`
 * (`kemfai_setup_get_state` / `kemfai_setup_save_step`). This service holds no business
 * logic of its own beyond that plumbing and typed-error translation (arbiter resolution
 * point 3): all VAT regex evaluation and field/country validation live in the Odoo addon.
 */
@Injectable()
export class CompanySetupService {
  constructor(
    private readonly tenantContextResolver: TenantContextResolver,
    private readonly odoo: OdooRpcService,
  ) {}

  async getState(req: TenantScopedRequest): Promise<CompanySetupStateDto> {
    const { db, uid, password, companyId } = await this.resolveTenantOdooContext(req);
    const result = await this.callOrTranslate(() =>
      this.odoo.executeKw(db, uid, password, 'res.company', 'kemfai_setup_get_state', [
        [companyId],
      ]),
    );
    return this.toDto(result);
  }

  async saveStep(
    req: TenantScopedRequest,
    body: CompanySetupStepRequestDto,
  ): Promise<CompanySetupStateDto> {
    const { db, uid, password, companyId } = await this.resolveTenantOdooContext(req);
    const result = await this.callOrTranslate(() =>
      this.odoo.executeKw(db, uid, password, 'res.company', 'kemfai_setup_save_step', [
        [companyId],
        body.step,
        body.values,
        body.baseVersion ?? null,
      ]),
    );
    return this.toDto(result);
  }

  private async resolveTenantOdooContext(
    req: TenantScopedRequest,
  ): Promise<{ db: string; uid: number; password: string; companyId: number }> {
    const tenantContext = await this.tenantContextResolver.resolveForRequest(req);
    if (!tenantContext.callerTenantId) {
      throw new InternalServerErrorException('No tenant resolved for this request');
    }
    const tenant = await controlDataSource
      .getRepository(Tenant)
      .findOneBy({ id: tenantContext.callerTenantId });
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

  /**
   * Translates the addon's `KEMFAI_<CODE>: ...` prefixed `ValidationError` messages
   * (the only typed-error channel a JSON-RPC fault carries, see
   * `odoo-rpc-client.ts`'s `body.error.data?.message`) into the documented HTTP responses
   * — 409 for a missing country validation rule (configuration gap, never silently
   * accepted), 422 for every other field-level failure. An unrecognized Odoo error never
   * becomes a leaked 500 message; it is replaced with a generic one.
   */
  private async callOrTranslate<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('KEMFAI_CONFIG_GAP')) {
        throw new ConflictException('No VAT/tax validation rule is configured for this country');
      }
      if (
        message.includes('KEMFAI_VAT_FORMAT') ||
        message.includes('KEMFAI_REQUIRED_FIELD') ||
        message.includes('KEMFAI_UNKNOWN_STEP') ||
        message.includes('KEMFAI_INVALID_COUNTRY') ||
        message.includes('KEMFAI_INVALID_CURRENCY') ||
        message.includes('KEMFAI_INVALID_INDUSTRY') ||
        message.includes('KEMFAI_INVALID_PAYLOAD')
      ) {
        throw new UnprocessableEntityException(stripKemfaiPrefix(message));
      }
      // Never pass through a raw Odoo/RPC error: it can contain internal detail.
      throw new InternalServerErrorException('Company setup is temporarily unavailable');
    }
  }

  private toDto(result: unknown): CompanySetupStateDto {
    const state = result as OdooCompanySetupState;
    return {
      currentStep: state.currentStep,
      setupComplete: state.setupComplete,
      values: state.values,
      version: state.version,
      stale: state.stale,
    };
  }
}

function stripKemfaiPrefix(message: string): string {
  const match = message.match(/KEMFAI_[A-Z_]+:\s*(.*)$/);
  return match ? match[1] : message;
}
