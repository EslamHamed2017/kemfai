import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
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
  DraftLineDto,
  DraftMutationResultDto,
  DraftPageDto,
  DraftValidationResultDto,
  DraftWriteDto,
  JournalDraftDto,
  ValidationIssueCode,
  ValidationIssueDto,
  ValidationMutationResultDto,
} from '../dto/draft.dto';
import {
  AccountingMutationHandoff,
  AccountingMutationHandoffState,
} from '../entities/accounting-mutation-handoff.entity';

const DRAFTS_ROUTE = '/v1/accounting/drafts';
const VIEW_PERMISSION = 'accounting.drafts.view';
const EDIT_PERMISSION = 'accounting.drafts.edit';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISSUE_CODES = new Set<ValidationIssueCode>([
  'ACCOUNT_NOT_POSTING',
  'ACCOUNT_INACTIVE',
  'JOURNAL_INACTIVE',
  'CURRENCY_DISABLED',
  'AMOUNT_SCALE_EXCEEDS_METADATA',
  'FX_RATE_REFERENCE_REQUIRED',
  'FX_RATE_EFFECTIVE_DATE_REQUIRED',
  'FX_METADATA_NOT_ALLOWED_FOR_BASE',
  'DEBIT_CREDIT_INVALID',
  'BASE_TOTALS_UNBALANCED',
  'DIMENSION_REQUIRED',
  'DIMENSION_PROHIBITED',
  'DIMENSION_INACTIVE',
  'DIMENSION_OUT_OF_SCOPE',
  'CONFIGURATION_STALE',
  'POLICY_APPROVAL_REQUIRED',
  'DRAFT_MINIMUM_LINES_REQUIRED',
  'DRAFT_LINE_AMOUNT_REQUIRED',
]);

type DraftAction = 'draft.save' | 'draft.update' | 'draft.validate';
type DraftEnvelope = {
  actor_identity: string;
  company_id: number;
  draft_id?: string;
  expected_version?: number;
  values?: DraftWriteDto;
};
type UpstreamIssue = {
  code: ValidationIssueCode;
  message_key?: string;
  line_id?: string | null;
  resource_id?: string | null;
  field?: string | null;
};
type UpstreamDimension = {
  definition_id: string;
  value_id: string;
  definition_name_en?: string;
  definition_name_ar?: string;
  value_name_en?: string;
  value_name_ar?: string;
  definition_version?: number;
  value_version?: number;
  active: boolean;
};
type UpstreamRuleVersion = {
  rule_id: string;
  rule_version: number;
  dimension_definition_id: string;
  dimension_definition_version: number;
  requirement: 'required' | 'optional' | 'prohibited';
};
type UpstreamLine = {
  id: string;
  sequence: number;
  account_id: string;
  account_code: string;
  account_name_en: string;
  account_name_ar: string;
  description?: string;
  transaction_currency_code: string;
  transaction_precision: number;
  transaction_currency_metadata_version: string;
  company_base_currency_code: string;
  base_precision: number;
  base_currency_metadata_version: string;
  currency_configuration_version: number;
  transaction_debit: string;
  transaction_credit: string;
  base_debit: string;
  base_credit: string;
  rate_reference: string | null;
  rate_effective_date: string | null;
  dimensions: UpstreamDimension[];
};
type UpstreamDraft = {
  id: string;
  company_id: number;
  version: number;
  status: 'draft';
  journal_id: string;
  accounting_date: string;
  description: string;
  transaction_type: 'manual_journal';
  source?: { type: string; id: string } | null;
  lines: UpstreamLine[];
  validation_state: 'not_validated' | 'stale' | 'valid_for_draft' | 'invalid';
  errors: UpstreamIssue[];
  rule_versions: UpstreamRuleVersion[];
  audit_event_id?: string;
  ledger_effect: 'none';
};

type MutationResult = {
  handoff: AccountingMutationHandoff;
  upstream: UpstreamDraft;
  correlationId: string;
  replayed: boolean;
};

@Injectable()
export class DraftsService {
  constructor(
    private readonly context: AccountingOdooContextService,
    private readonly odoo: OdooRpcService,
    private readonly handoffs: AccountingMutationHandoffService,
    private readonly audit: AccountingPlatformAuditService,
  ) {}

  async list(
    req: TenantScopedRequest,
    companyUuid: string,
    filters: { cursor?: string; limit: number },
  ): Promise<DraftPageDto> {
    const context = await this.context.resolve(req, companyUuid);
    await this.requirePermission(req, context, VIEW_PERMISSION, DRAFTS_ROUTE);
    const value = await this.odoo.executeKw(
      context.db,
      context.uid,
      context.password,
      'kemfai.account.draft',
      'kemfai_list_minimal_drafts',
      [context.companyId, filters],
      this.kwargs(context),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new InternalServerErrorException('Accounting engine returned invalid draft page');
    }
    const page = value as { items?: unknown; next_cursor?: unknown };
    if (
      !Array.isArray(page.items) ||
      !(
        page.next_cursor === null ||
        page.next_cursor === undefined ||
        this.isUuid(page.next_cursor)
      )
    ) {
      throw new InternalServerErrorException('Accounting engine returned invalid draft page');
    }
    return {
      items: page.items.map((item) => {
        this.assertUpstream(item, false);
        return this.toDraft(item, context.companyUuid);
      }),
      nextCursor: (page.next_cursor as string | null | undefined) ?? null,
    };
  }

  async save(
    req: TenantScopedRequest,
    companyUuid: string,
    body: DraftWriteDto,
  ): Promise<DraftMutationResultDto> {
    const context = await this.context.resolve(req, companyUuid);
    await this.requirePermission(req, context, EDIT_PERMISSION, DRAFTS_ROUTE);
    const result = await this.mutate(req, context, DRAFTS_ROUTE, 'draft.save', {
      actor_identity: req.auth.keycloakUserId,
      company_id: context.companyId,
      values: body,
    });
    return {
      ...this.receipt(result),
      resource: this.toDraft(result.upstream, context.companyUuid),
      ledgerEffect: 'none',
    };
  }

  async update(
    req: TenantScopedRequest,
    companyUuid: string,
    draftId: string,
    expectedVersion: number,
    body: DraftWriteDto,
  ): Promise<DraftMutationResultDto> {
    const context = await this.context.resolve(req, companyUuid);
    const route = `${DRAFTS_ROUTE}/${draftId}`;
    await this.requirePermission(req, context, EDIT_PERMISSION, route);
    const result = await this.mutate(req, context, route, 'draft.update', {
      actor_identity: req.auth.keycloakUserId,
      company_id: context.companyId,
      draft_id: draftId,
      expected_version: expectedVersion,
      values: body,
    });
    return {
      ...this.receipt(result),
      resource: this.toDraft(result.upstream, context.companyUuid),
      ledgerEffect: 'none',
    };
  }

  async get(
    req: TenantScopedRequest,
    companyUuid: string,
    draftId: string,
  ): Promise<JournalDraftDto> {
    const context = await this.context.resolve(req, companyUuid);
    const route = `${DRAFTS_ROUTE}/${draftId}`;
    await this.requirePermission(req, context, VIEW_PERMISSION, route);
    try {
      const value = await this.odoo.executeKw(
        context.db,
        context.uid,
        context.password,
        'kemfai.account.draft',
        'kemfai_read_minimal_draft',
        [draftId, context.companyId],
        this.kwargs(context),
      );
      this.assertUpstream(value, false);
      return this.toDraft(value, context.companyUuid);
    } catch (error) {
      if (this.isKnownFault(error)) this.translateKnownFault(error);
      throw error;
    }
  }

  async validate(
    req: TenantScopedRequest,
    companyUuid: string,
    draftId: string,
    expectedVersion: number,
  ): Promise<ValidationMutationResultDto> {
    const context = await this.context.resolve(req, companyUuid);
    const route = `${DRAFTS_ROUTE}/${draftId}/validate`;
    await this.requirePermission(req, context, EDIT_PERMISSION, route);
    const result = await this.mutate(req, context, route, 'draft.validate', {
      actor_identity: req.auth.keycloakUserId,
      company_id: context.companyId,
      draft_id: draftId,
      expected_version: expectedVersion,
    });
    return {
      ...this.receipt(result),
      result: this.toValidation(result.upstream),
      ledgerEffect: 'none',
    };
  }

  private async mutate(
    req: TenantScopedRequest,
    context: AccountingOdooContext,
    route: string,
    action: DraftAction,
    envelope: DraftEnvelope,
  ): Promise<MutationResult> {
    const idempotencyKey = this.header(req, 'idempotency-key');
    if (!idempotencyKey) throw new ConflictException('Idempotency-Key is required');
    const correlationId = this.header(req, 'x-correlation-id');
    if (!correlationId) {
      throw new UnprocessableEntityException('Correlation identifier is required');
    }
    const handoff = await this.handoffs.findOrCreateHandoff({
      tenantId: context.tenantId,
      companyUuid: context.companyUuid,
      actorAccountId: context.accountId,
      principalIdentity: req.auth.keycloakUserId,
      odooDbName: context.db,
      odooCompanyId: context.companyId,
      callerScope: `keycloak:${req.auth.keycloakUserId}:tenant:${context.tenantId}`,
      method: action === 'draft.update' ? 'PUT' : 'POST',
      route,
      action,
      idempotencyKey,
      requestFingerprint: fingerprintOf({ action, ...envelope }),
      requestPayload: envelope as unknown as Record<string, unknown>,
    });
    if (handoff.state === AccountingMutationHandoffState.AUDITED) {
      this.assertUpstream(handoff.finalResponse, true);
      return { handoff, upstream: handoff.finalResponse, correlationId, replayed: true };
    }

    if (handoff.state === AccountingMutationHandoffState.REJECTED) {
      this.translateKnownFault(new Error(handoff.lastErrorCode ?? 'ACCOUNTING_REJECTED'));
    }

    let upstream: unknown = handoff.finalResponse;
    if (handoff.state === AccountingMutationHandoffState.PENDING) {
      try {
        upstream = await this.execute(handoff, context, envelope);
        this.assertUpstream(upstream, true);
        await this.handoffs.markOdooCommitted(handoff.id, upstream);
      } catch (error) {
        const errorCode = deterministicAccountingFaultCode(error);
        if (errorCode) {
          await this.handoffs.markRejected(handoff.id, errorCode);
          this.translateKnownFault(error);
        }
        await this.handoffs.scheduleRetryBackoff(handoff.id, 1_000);
        if (error instanceof UnprocessableEntityException) throw error;
        throw new ServiceUnavailableException(
          'Draft mutation could not be confirmed and will be recovered automatically',
        );
      }
    }

    this.assertUpstream(upstream, true);
    const committed = Object.assign(new AccountingMutationHandoff(), handoff, {
      state: AccountingMutationHandoffState.ODOO_COMMITTED,
      finalResponse: upstream,
      odooCommittedAt: handoff.odooCommittedAt ?? new Date(),
    });
    try {
      await this.audit.recordAccountingMutation(committed);
      await this.handoffs.markAudited(handoff.id);
    } catch {
      await this.handoffs.scheduleRetryBackoff(handoff.id, 1_000);
      throw new ServiceUnavailableException(
        'Accounting audit is temporarily unavailable; recovery remains scheduled',
      );
    }
    return { handoff: committed, upstream, correlationId, replayed: false };
  }

  private execute(
    handoff: AccountingMutationHandoff,
    context: AccountingOdooContext,
    envelope: DraftEnvelope,
  ): Promise<unknown> {
    const common = [handoff.id, envelope.actor_identity];
    if (handoff.action === 'draft.save') {
      return this.odoo.executeKw(
        context.db,
        context.uid,
        context.password,
        'kemfai.account.draft',
        'kemfai_save_minimal_draft',
        [...common, context.companyId, envelope.values],
        this.kwargs(context),
      );
    }
    if (handoff.action === 'draft.update') {
      return this.odoo.executeKw(
        context.db,
        context.uid,
        context.password,
        'kemfai.account.draft',
        'kemfai_update_minimal_draft',
        [
          ...common,
          envelope.draft_id,
          envelope.expected_version,
          context.companyId,
          envelope.values,
        ],
        this.kwargs(context),
      );
    }
    return this.odoo.executeKw(
      context.db,
      context.uid,
      context.password,
      'kemfai.account.draft',
      'kemfai_validate_minimal_draft',
      [...common, envelope.draft_id, envelope.expected_version, context.companyId],
      this.kwargs(context),
    );
  }

  private kwargs(context: AccountingOdooContext) {
    return {
      context: {
        allowed_company_ids: [context.companyId],
        force_company: context.companyId,
      },
    };
  }

  private receipt(result: MutationResult) {
    return {
      operationId: result.handoff.id,
      auditEventId: result.upstream.audit_event_id!,
      correlationId: result.correlationId,
      replayed: result.replayed,
    };
  }

  private toDraft(value: UpstreamDraft, companyUuid: string): JournalDraftDto {
    return {
      id: value.id,
      companyId: companyUuid,
      version: value.version,
      status: 'draft',
      journalId: value.journal_id,
      accountingDate: value.accounting_date,
      description: value.description,
      transactionType: 'manual_journal',
      ...(value.source !== undefined ? { source: value.source } : {}),
      lines: value.lines.map((line) => this.toLine(line)),
      validationState: value.validation_state,
      ledgerEffect: 'none',
    };
  }

  private toLine(line: UpstreamLine): DraftLineDto {
    return {
      id: line.id,
      sequence: line.sequence,
      accountId: line.account_id,
      ...(line.description !== undefined ? { description: line.description } : {}),
      transactionCurrencyCode: line.transaction_currency_code,
      transactionPrecision: line.transaction_precision,
      transactionCurrencyMetadataVersion: line.transaction_currency_metadata_version,
      companyBaseCurrencyCode: line.company_base_currency_code,
      basePrecision: line.base_precision,
      baseCurrencyMetadataVersion: line.base_currency_metadata_version,
      currencyConfigurationVersion: line.currency_configuration_version,
      transactionDebit: line.transaction_debit,
      transactionCredit: line.transaction_credit,
      baseDebit: line.base_debit,
      baseCredit: line.base_credit,
      rateReference: line.rate_reference,
      rateEffectiveDate: line.rate_effective_date,
      accountCode: line.account_code,
      accountName: { en: line.account_name_en, ar: line.account_name_ar },
      dimensions: line.dimensions.map((assignment) => ({
        definitionId: assignment.definition_id,
        valueId: assignment.value_id,
        definitionName: {
          en: assignment.definition_name_en ?? '',
          ar: assignment.definition_name_ar ?? '',
        },
        valueName: {
          en: assignment.value_name_en ?? '',
          ar: assignment.value_name_ar ?? '',
        },
        active: assignment.active,
      })),
    };
  }

  private toValidation(value: UpstreamDraft): DraftValidationResultDto {
    const errors = value.errors.map((issue) => this.toIssue(issue));
    return {
      id: value.audit_event_id!,
      draftId: value.id,
      draftVersion: value.version,
      status: errors.length ? 'invalid' : 'valid_for_draft',
      ledgerEffect: 'none',
      checksPerformed: ['scope', 'account_activity_and_kind', 'dimension_rules'],
      errors,
      warnings: [],
      policyBlockers: [],
      companyBaseCurrencyCode: value.lines[0]?.company_base_currency_code ?? '',
      basePrecision: value.lines[0]?.base_precision ?? 0,
      baseDebitTotal: value.lines[0]?.base_debit ?? '0',
      baseCreditTotal: value.lines[0]?.base_credit ?? '0',
      configurationSnapshot: {
        accounts: {},
        dimensionRules: Object.fromEntries(
          value.rule_versions.map((rule) => [rule.rule_id, rule.rule_version]),
        ),
        journal: { id: value.journal_id, version: 1 },
        currencies: {},
      },
      validatedAt: new Date().toISOString(),
    };
  }

  private toIssue(issue: UpstreamIssue): ValidationIssueDto {
    return {
      code: issue.code,
      messageKey: issue.message_key ?? issue.code,
      lineId: issue.line_id,
      resourceId: issue.resource_id,
      field: issue.field,
    };
  }

  private assertUpstream(value: unknown, requireAudit: boolean): asserts value is UpstreamDraft {
    const row = value as Partial<UpstreamDraft> | null;
    const validLines =
      Array.isArray(row?.lines) && row.lines.every((line) => this.isValidLine(line));
    const validIssues =
      Array.isArray(row?.errors) && row.errors.every((issue) => this.isValidIssue(issue));
    const validRuleVersions =
      Array.isArray(row?.rule_versions) &&
      row.rule_versions.every((rule) => this.isValidRuleVersion(rule));
    if (
      !row ||
      typeof row !== 'object' ||
      !this.isUuid(row.id) ||
      !Number.isInteger(row.company_id) ||
      !Number.isInteger(row.version) ||
      (row.version ?? 0) < 1 ||
      row.status !== 'draft' ||
      !this.isUuid(row.journal_id) ||
      typeof row.accounting_date !== 'string' ||
      typeof row.description !== 'string' ||
      row.transaction_type !== 'manual_journal' ||
      !validLines ||
      !['not_validated', 'stale', 'valid_for_draft', 'invalid'].includes(
        row.validation_state ?? '',
      ) ||
      !validIssues ||
      !validRuleVersions ||
      row.ledger_effect !== 'none' ||
      (requireAudit && !this.isUuid(row.audit_event_id))
    ) {
      throw new UnprocessableEntityException(
        'Accounting engine returned invalid non-posting draft data',
      );
    }
  }

  private isValidLine(value: unknown): value is UpstreamLine {
    const line = value as Partial<UpstreamLine> | null;
    return Boolean(
      line &&
      this.isUuid(line.id) &&
      Number.isInteger(line.sequence) &&
      this.isUuid(line.account_id) &&
      typeof line.account_code === 'string' &&
      typeof line.account_name_en === 'string' &&
      typeof line.account_name_ar === 'string' &&
      typeof line.transaction_currency_code === 'string' &&
      Number.isInteger(line.transaction_precision) &&
      typeof line.transaction_currency_metadata_version === 'string' &&
      typeof line.company_base_currency_code === 'string' &&
      Number.isInteger(line.base_precision) &&
      typeof line.base_currency_metadata_version === 'string' &&
      Number.isInteger(line.currency_configuration_version) &&
      typeof line.transaction_debit === 'string' &&
      typeof line.transaction_credit === 'string' &&
      typeof line.base_debit === 'string' &&
      typeof line.base_credit === 'string' &&
      (line.rate_reference === null || typeof line.rate_reference === 'string') &&
      (line.rate_effective_date === null || typeof line.rate_effective_date === 'string') &&
      Array.isArray(line.dimensions) &&
      line.dimensions.every((assignment) => this.isValidDimension(assignment)),
    );
  }

  private isValidDimension(value: unknown): value is UpstreamDimension {
    const assignment = value as Partial<UpstreamDimension> | null;
    return Boolean(
      assignment &&
      this.isUuid(assignment.definition_id) &&
      this.isUuid(assignment.value_id) &&
      typeof assignment.active === 'boolean' &&
      (assignment.definition_name_en === undefined ||
        typeof assignment.definition_name_en === 'string') &&
      (assignment.definition_name_ar === undefined ||
        typeof assignment.definition_name_ar === 'string') &&
      (assignment.value_name_en === undefined || typeof assignment.value_name_en === 'string') &&
      (assignment.value_name_ar === undefined || typeof assignment.value_name_ar === 'string') &&
      (assignment.definition_version === undefined ||
        (Number.isInteger(assignment.definition_version) && assignment.definition_version > 0)) &&
      (assignment.value_version === undefined ||
        (Number.isInteger(assignment.value_version) && assignment.value_version > 0)),
    );
  }

  private isValidRuleVersion(value: unknown): value is UpstreamRuleVersion {
    const rule = value as Partial<UpstreamRuleVersion> | null;
    return Boolean(
      rule &&
      this.isUuid(rule.rule_id) &&
      Number.isInteger(rule.rule_version) &&
      (rule.rule_version ?? 0) > 0 &&
      this.isUuid(rule.dimension_definition_id) &&
      Number.isInteger(rule.dimension_definition_version) &&
      (rule.dimension_definition_version ?? 0) > 0 &&
      ['required', 'optional', 'prohibited'].includes(rule.requirement ?? ''),
    );
  }

  private isValidIssue(value: unknown): value is UpstreamIssue {
    const issue = value as Partial<UpstreamIssue> | null;
    return Boolean(
      issue && typeof issue.code === 'string' && ISSUE_CODES.has(issue.code as ValidationIssueCode),
    );
  }

  private async requirePermission(
    req: TenantScopedRequest,
    context: AccountingOdooContext,
    permission: string,
    route: string,
  ): Promise<void> {
    if (req.auth.roles.includes(permission)) return;
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

  private isKnownFault(error: unknown): boolean {
    return deterministicAccountingFaultCode(error) !== null;
  }

  private translateKnownFault(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('DRAFT_NOT_FOUND')) throw new NotFoundException('Draft was not found');
    if (message.includes('STALE_VERSION')) {
      throw new PreconditionFailedException('STALE_VERSION');
    }
    throw new UnprocessableEntityException(
      message.match(/(?:ACCOUNT|DRAFT|STALE)_[A-Z_]+/)?.[0] ?? 'DRAFT_VALIDATION_FAILED',
    );
  }

  private header(req: TenantScopedRequest, name: string): string | undefined {
    const value = req.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  }

  private isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
  }
}
