import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { TenantContextResolver } from '../../common/tenant-context/tenant-context.resolver';
import { TenantScopedRequest } from '../../common/tenant-context/tenant-context.model';
import { OdooRpcService } from '../../integrations/odoo-rpc/odoo-rpc.service';
import { provisioningCredentials } from '../../integrations/provisioning/credentials';
import { Tenant, TenantStatus } from '../tenants/entities/tenant.entity';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_COMPANY_NOT_FOUND = 'Accounting company was not found';

/** Internal-only routing context. Controllers and response DTOs must never serialize it. */
export interface AccountingOdooContext {
  tenantId: string;
  accountId: string;
  companyUuid: string;
  db: string;
  uid: number;
  password: string;
  companyId: number;
}

type CompanyRow = { id?: unknown; kemfai_public_id?: unknown };

/**
 * Resolves an accounting request to one exact tenant database and company. Tenant and
 * account authority come only from the verified-JWT TenantContextResolver. The public
 * company UUID is looked up only after that route is fixed, so a foreign UUID is denied
 * before any accounting resource lookup and no Odoo integer/database identifier escapes.
 */
@Injectable()
export class AccountingOdooContextService {
  constructor(
    private readonly tenantContextResolver: TenantContextResolver,
    private readonly odoo: OdooRpcService,
  ) {}

  async resolve(
    req: TenantScopedRequest,
    requestedCompanyUuid: string,
  ): Promise<AccountingOdooContext> {
    const companyUuid = requestedCompanyUuid?.trim().toLowerCase();
    if (!companyUuid || !UUID_PATTERN.test(companyUuid)) {
      throw new NotFoundException(OPAQUE_COMPANY_NOT_FOUND);
    }

    const caller = await this.tenantContextResolver.resolveForRequest(req);
    if (!caller.callerTenantId || !caller.accountId) {
      throw new NotFoundException(OPAQUE_COMPANY_NOT_FOUND);
    }

    const tenant = await controlDataSource.getRepository(Tenant).findOneBy({
      id: caller.callerTenantId,
      accountId: caller.accountId,
    });
    if (!tenant) {
      throw new NotFoundException(OPAQUE_COMPANY_NOT_FOUND);
    }
    if (tenant.status !== TenantStatus.READY || !tenant.odooDbName) {
      throw new InternalServerErrorException('Accounting workspace is not ready');
    }

    const { login, password } = provisioningCredentials();
    let uid: number;
    let result: unknown;
    try {
      uid = await this.odoo.authenticate(tenant.odooDbName, login, password);
      result = await this.odoo.executeKw(
        tenant.odooDbName,
        uid,
        password,
        'res.company',
        'search_read',
        [[['kemfai_public_id', '=', companyUuid]]],
        { fields: ['id', 'kemfai_public_id'], limit: 2 },
      );
    } catch {
      throw new ServiceUnavailableException('Accounting workspace is temporarily unavailable');
    }

    if (!Array.isArray(result) || result.length === 0) {
      throw new NotFoundException(OPAQUE_COMPANY_NOT_FOUND);
    }
    if (result.length !== 1) {
      throw new InternalServerErrorException('Accounting company mapping is invalid');
    }
    const company = result[0] as CompanyRow;
    if (!Number.isInteger(company.id) || company.kemfai_public_id !== companyUuid) {
      throw new InternalServerErrorException('Accounting company mapping is invalid');
    }

    return {
      tenantId: caller.callerTenantId,
      accountId: caller.accountId,
      companyUuid,
      db: tenant.odooDbName,
      uid,
      password,
      companyId: company.id as number,
    };
  }
}
