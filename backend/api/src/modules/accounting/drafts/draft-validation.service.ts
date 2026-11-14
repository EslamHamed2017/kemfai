import {
  ConflictException,
  ForbiddenException,
  Injectable,
  PreconditionFailedException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { fingerprintOf } from '../../../common/interceptors/idempotency.interceptor';
import { TenantScopedRequest } from '../../../common/tenant-context/tenant-context.model';
import { OdooRpcService } from '../../../integrations/odoo-rpc/odoo-rpc.service';
import { deterministicAccountingFaultCode } from '../accounting-odoo-fault';
import { AccountingMutationHandoffService } from '../accounting-mutation-handoff.service';
import {
  AccountingOdooContext,
  AccountingOdooContextService,
} from '../accounting-odoo-context.service';
import { AccountingPlatformAuditService } from '../accounting-platform-audit.service';
import {
  DraftValidationResultDto,
  ValidationCheck,
  ValidationIssueDto,
  ValidationIssueCode,
  ValidationMutationResultDto,
} from '../dto/draft.dto';
import {
  AccountingMutationHandoff,
  AccountingMutationHandoffState,
} from '../entities/accounting-mutation-handoff.entity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROUTE = '/v1/accounting/drafts';
const CHECK_MAP: Record<string, ValidationCheck> = {
  exact_decimal_lexemes: 'exact_money_metadata',
  debit_credit_exclusivity: 'debit_credit_shape',
  base_arithmetic: 'base_arithmetic',
  journal_activity_and_version: 'journal_activity',
  currency_activity_and_versions: 'currency_completeness',
  conditional_fx_provenance: 'fx_provenance',
};
type Issue = {
  code: string;
  message_key?: string;
  line_id?: string | null;
  resource_id?: string | null;
  field?: string | null;
};
type Version = {
  kind: 'account' | 'journal' | 'currency';
  resource_id?: string;
  snapshot_version?: number;
  configuration_id?: string;
  configuration_version?: number;
  currency_code?: string;
  native_metadata_version?: string;
  native_decimal_places?: number;
};
type Rule = { rule_id: string; rule_version: number };
type Upstream = {
  id: string;
  version: number;
  validation_state: 'valid_for_draft' | 'invalid';
  validation_run_id: string;
  checks_performed: string[];
  errors: Issue[];
  warnings: Issue[];
  policy_blockers: Issue[];
  base_debit_total: string;
  base_credit_total: string;
  company_base_currency_code: string;
  base_precision: number;
  validated_at: string;
  audit_event_id: string;
  configuration_versions: Version[];
  rule_versions: Rule[];
  ledger_effect: 'none';
};

@Injectable()
export class DraftValidationService {
  constructor(
    private readonly context: AccountingOdooContextService,
    private readonly odoo: OdooRpcService,
    private readonly handoffs: AccountingMutationHandoffService,
    private readonly audit: AccountingPlatformAuditService,
  ) {}
  async validate(
    req: TenantScopedRequest,
    companyUuid: string,
    draftId: string,
    expectedVersion: number,
  ): Promise<ValidationMutationResultDto> {
    const context = await this.context.resolve(req, companyUuid);
    const route = `${ROUTE}/${draftId}/validate`;
    if (!req.auth.roles.includes('accounting.drafts.edit')) {
      await this.audit.recordPreDomainDenial({
        operationUuid: randomUUID(),
        tenantId: context.tenantId,
        companyUuid: context.companyUuid,
        actorAccountId: context.accountId,
        route,
        reason: 'permission_denied',
      });
      throw new ForbiddenException('Accounting access denied');
    }
    const key = this.header(req, 'idempotency-key');
    if (!key) throw new ConflictException('Idempotency-Key is required');
    const correlationId = this.header(req, 'x-correlation-id');
    if (!correlationId)
      throw new UnprocessableEntityException('Correlation identifier is required');
    const envelope = {
      actor_identity: req.auth.keycloakUserId,
      draft_id: draftId,
      expected_version: expectedVersion,
    };
    const handoff = await this.handoffs.findOrCreateHandoff({
      tenantId: context.tenantId,
      companyUuid: context.companyUuid,
      actorAccountId: context.accountId,
      principalIdentity: req.auth.keycloakUserId,
      odooDbName: context.db,
      odooCompanyId: context.companyId,
      callerScope: `keycloak:${req.auth.keycloakUserId}:tenant:${context.tenantId}`,
      method: 'POST',
      route,
      action: 'draft.validate',
      idempotencyKey: key,
      requestFingerprint: fingerprintOf({ action: 'draft.validate', ...envelope }),
      requestPayload: { ...envelope, company_id: context.companyId },
    });
    if (handoff.state === AccountingMutationHandoffState.AUDITED)
      return this.result(handoff, correlationId, true);
    if (handoff.state === AccountingMutationHandoffState.REJECTED)
      this.translate(new Error(handoff.lastErrorCode ?? 'DRAFT_VALIDATION_FAILED'));
    let value: unknown = handoff.finalResponse;
    if (handoff.state === AccountingMutationHandoffState.PENDING) {
      try {
        value = await this.odoo.executeKw(
          context.db,
          context.uid,
          context.password,
          'kemfai.account.draft',
          'kemfai_validate_minimal_draft',
          [handoff.id, envelope.actor_identity, draftId, expectedVersion, context.companyId],
          this.kwargs(context),
        );
        this.assert(value);
        await this.handoffs.markOdooCommitted(handoff.id, value);
      } catch (error) {
        const errorCode = deterministicAccountingFaultCode(error);
        if (errorCode) {
          await this.handoffs.markRejected(handoff.id, errorCode);
          this.translate(error);
        }
        await this.handoffs.scheduleRetryBackoff(handoff.id, 1000);
        throw new ServiceUnavailableException(
          'Draft validation could not be confirmed and will be recovered automatically',
        );
      }
    }
    this.assert(value);
    const committed = Object.assign(new AccountingMutationHandoff(), handoff, {
      state: AccountingMutationHandoffState.ODOO_COMMITTED,
      finalResponse: value,
      odooCommittedAt: handoff.odooCommittedAt ?? new Date(),
    });
    try {
      await this.audit.recordAccountingMutation(committed);
      await this.handoffs.markAudited(handoff.id);
    } catch {
      await this.handoffs.scheduleRetryBackoff(handoff.id, 1000);
      throw new ServiceUnavailableException(
        'Accounting audit is temporarily unavailable; recovery remains scheduled',
      );
    }
    return this.result(committed, correlationId, false);
  }
  private result(
    handoff: AccountingMutationHandoff,
    correlationId: string,
    replayed: boolean,
  ): ValidationMutationResultDto {
    this.assert(handoff.finalResponse);
    return {
      operationId: handoff.id,
      auditEventId: handoff.finalResponse.audit_event_id,
      correlationId,
      replayed,
      ledgerEffect: 'none',
      result: this.map(handoff.finalResponse),
    };
  }
  private map(v: Upstream): DraftValidationResultDto {
    const accounts: Record<string, number> = {},
      currencies: DraftValidationResultDto['configurationSnapshot']['currencies'] = {};
    let journal = { id: '', version: 0 };
    for (const item of v.configuration_versions) {
      if (item.kind === 'account' && item.resource_id && Number.isInteger(item.snapshot_version))
        accounts[item.resource_id] = item.snapshot_version!;
      else if (
        item.kind === 'journal' &&
        item.resource_id &&
        Number.isInteger(item.snapshot_version)
      )
        journal = { id: item.resource_id, version: item.snapshot_version! };
      else if (
        item.kind === 'currency' &&
        item.currency_code &&
        Number.isInteger(item.configuration_version) &&
        item.native_metadata_version !== undefined &&
        Number.isInteger(item.native_decimal_places)
      )
        currencies[item.currency_code] = {
          currencyCode: item.currency_code,
          configurationVersion: item.configuration_version!,
          nativeMetadataVersion: item.native_metadata_version,
          nativeDecimalPlaces: item.native_decimal_places!,
        };
    }
    return {
      id: v.validation_run_id,
      draftId: v.id,
      draftVersion: v.version,
      status: v.validation_state,
      ledgerEffect: 'none',
      checksPerformed: v.checks_performed.map(
        (check) => CHECK_MAP[check] ?? check,
      ) as ValidationCheck[],
      errors: v.errors.map((x) => this.issue(x)),
      warnings: v.warnings.map((x) => this.issue(x)),
      policyBlockers: v.policy_blockers.map((x) => this.issue(x)),
      companyBaseCurrencyCode: v.company_base_currency_code,
      basePrecision: v.base_precision,
      baseDebitTotal: v.base_debit_total,
      baseCreditTotal: v.base_credit_total,
      configurationSnapshot: {
        accounts,
        dimensionRules: Object.fromEntries(v.rule_versions.map((x) => [x.rule_id, x.rule_version])),
        journal,
        currencies,
      },
      validatedAt: v.validated_at,
    };
  }
  private issue(v: Issue): ValidationIssueDto {
    return {
      code: v.code as ValidationIssueCode,
      messageKey: v.message_key ?? v.code,
      ...(v.line_id !== undefined ? { lineId: v.line_id } : {}),
      ...(v.resource_id !== undefined ? { resourceId: v.resource_id } : {}),
      ...(v.field !== undefined ? { field: v.field } : {}),
    };
  }
  private assert(value: unknown): asserts value is Upstream {
    const v = value as Partial<Upstream> | null;
    if (
      !v ||
      typeof v !== 'object' ||
      !this.uuid(v.id) ||
      !this.uuid(v.validation_run_id) ||
      !this.uuid(v.audit_event_id) ||
      !Number.isInteger(v.version) ||
      !['valid_for_draft', 'invalid'].includes(v.validation_state ?? '') ||
      v.ledger_effect !== 'none' ||
      !Array.isArray(v.checks_performed) ||
      !Array.isArray(v.errors) ||
      !Array.isArray(v.warnings) ||
      !Array.isArray(v.policy_blockers) ||
      !Array.isArray(v.configuration_versions) ||
      !Array.isArray(v.rule_versions) ||
      typeof v.base_debit_total !== 'string' ||
      typeof v.base_credit_total !== 'string' ||
      typeof v.company_base_currency_code !== 'string' ||
      !Number.isInteger(v.base_precision) ||
      typeof v.validated_at !== 'string'
    )
      throw new UnprocessableEntityException(
        'Accounting engine returned invalid validation evidence',
      );
  }
  private known(error: unknown): boolean {
    return deterministicAccountingFaultCode(error) !== null;
  }
  private translate(e: unknown): never {
    const m = e instanceof Error ? e.message : String(e);
    if (m.includes('STALE_VERSION')) throw new PreconditionFailedException('STALE_VERSION');
    throw new UnprocessableEntityException('DRAFT_VALIDATION_FAILED');
  }
  private kwargs(c: AccountingOdooContext) {
    return { context: { allowed_company_ids: [c.companyId], force_company: c.companyId } };
  }
  private header(req: TenantScopedRequest, name: string) {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  }
  private uuid(v: unknown): v is string {
    return typeof v === 'string' && UUID.test(v);
  }
}
