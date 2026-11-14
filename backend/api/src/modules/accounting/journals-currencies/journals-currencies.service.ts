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
  CurrencyConfigurationDto,
  CurrencyConfigurationMutationResultDto,
  CurrencyConfigurationPageDto,
  CurrencyConfigurationPutDto,
  JournalCreateDto,
  JournalDto,
  JournalMutationResultDto,
  JournalPageDto,
  JournalUpdateDto,
} from '../dto/journal-currency.dto';
import {
  AccountingMutationHandoff,
  AccountingMutationHandoffState,
} from '../entities/accounting-mutation-handoff.entity';

const JOURNALS_ROUTE = '/v1/accounting/journals';
const CURRENCIES_ROUTE = '/v1/accounting/currencies';
const VIEW_PERMISSION = 'accounting.coa.view';
const CREATE_PERMISSION = 'accounting.coa.create';
const EDIT_PERMISSION = 'accounting.coa.edit';

type AccountingAction = 'journal.create' | 'journal.update' | 'currency.put';
type MutationEnvelope = {
  actor_identity: string;
  journal_id?: string;
  expected_version?: number;
  currency_code?: string;
  if_match?: string;
  values: Record<string, unknown>;
};
type UpstreamJournal = {
  id: string;
  company_id: string;
  code: string;
  name_en: string;
  name_ar: string;
  type: 'general';
  active: boolean;
  version: number;
  audit_event_id?: string;
};
type UpstreamCurrency = {
  id: string;
  company_id: string;
  currency_code: string;
  native_decimal_places: number;
  native_metadata_version: string;
  is_base: boolean;
  enabled: boolean;
  version: number;
  audit_event_id?: string;
};

@Injectable()
export class JournalsCurrenciesService {
  constructor(
    private readonly context: AccountingOdooContextService,
    private readonly odoo: OdooRpcService,
    private readonly handoffs: AccountingMutationHandoffService,
    private readonly audit: AccountingPlatformAuditService,
  ) {}

  async listJournals(
    req: TenantScopedRequest,
    companyUuid: string,
    filters: { active?: boolean },
  ): Promise<JournalPageDto> {
    const context = await this.context.resolve(req, companyUuid);
    await this.requirePermission(req, context, VIEW_PERMISSION, JOURNALS_ROUTE);
    try {
      const result = await this.odoo.executeKw(
        context.db,
        context.uid,
        context.password,
        'account.journal',
        'kemfai_list_journals',
        [context.companyId, filters],
        this.kwargs(context),
      );
      if (!result || typeof result !== 'object' || Array.isArray(result)) this.invalidPage();
      const page = result as { items?: unknown; next_cursor?: unknown };
      if (
        !Array.isArray(page.items) ||
        !(page.next_cursor == null || this.isUuid(page.next_cursor))
      ) {
        this.invalidPage();
      }
      return {
        items: page.items.map((item) => this.toJournal(item, context.companyUuid)),
        nextCursor: (page.next_cursor as string | null | undefined) ?? null,
      };
    } catch (error) {
      if (this.isKnownFault(error)) this.translateKnownFault(error);
      throw error;
    }
  }

  async listCurrencies(
    req: TenantScopedRequest,
    companyUuid: string,
    filters: { enabled?: boolean },
  ): Promise<CurrencyConfigurationPageDto> {
    const context = await this.context.resolve(req, companyUuid);
    await this.requirePermission(req, context, VIEW_PERMISSION, CURRENCIES_ROUTE);
    try {
      const result = await this.odoo.executeKw(
        context.db,
        context.uid,
        context.password,
        'kemfai.account.currency.config',
        'kemfai_list_currency_configurations',
        [context.companyId, filters],
        this.kwargs(context),
      );
      if (!result || typeof result !== 'object' || Array.isArray(result)) this.invalidPage();
      const page = result as { items?: unknown; next_cursor?: unknown };
      if (
        !Array.isArray(page.items) ||
        !(page.next_cursor == null || this.isUuid(page.next_cursor))
      ) {
        this.invalidPage();
      }
      return {
        items: page.items.map((item) => this.toCurrency(item, context.companyUuid)),
        nextCursor: (page.next_cursor as string | null | undefined) ?? null,
      };
    } catch (error) {
      if (this.isKnownFault(error)) this.translateKnownFault(error);
      throw error;
    }
  }

  async putCurrencyConfiguration(
    req: TenantScopedRequest,
    companyUuid: string,
    currencyCode: string,
    ifMatch: string,
    body: CurrencyConfigurationPutDto,
  ): Promise<CurrencyConfigurationMutationResultDto> {
    if (!(ifMatch === '*' || /^"[1-9][0-9]*"$/.test(ifMatch))) {
      throw new PreconditionFailedException('PRECONDITION_FAILED');
    }
    const context = await this.context.resolve(req, companyUuid);
    const route = `${CURRENCIES_ROUTE}/${currencyCode}`;
    await this.requirePermission(req, context, EDIT_PERMISSION, route);
    return this.mutate(req, context, 'PUT', route, 'currency.put', {
      actor_identity: req.auth.keycloakUserId,
      currency_code: currencyCode,
      if_match: ifMatch,
      values: { enabled: body.enabled },
    }) as Promise<CurrencyConfigurationMutationResultDto>;
  }

  async createJournal(
    req: TenantScopedRequest,
    companyUuid: string,
    body: JournalCreateDto,
  ): Promise<JournalMutationResultDto> {
    const context = await this.context.resolve(req, companyUuid);
    await this.requirePermission(req, context, CREATE_PERMISSION, JOURNALS_ROUTE);
    return this.mutate(req, context, 'POST', JOURNALS_ROUTE, 'journal.create', {
      actor_identity: req.auth.keycloakUserId,
      values: {
        company_id: context.companyId,
        code: body.code,
        name_en: body.name.en,
        name_ar: body.name.ar,
        type: body.journalType ?? 'general',
        active: body.active ?? true,
      },
    }) as Promise<JournalMutationResultDto>;
  }

  async updateJournal(
    req: TenantScopedRequest,
    companyUuid: string,
    journalId: string,
    expectedVersion: number,
    body: JournalUpdateDto,
  ): Promise<JournalMutationResultDto> {
    const context = await this.context.resolve(req, companyUuid);
    const route = `${JOURNALS_ROUTE}/${journalId}`;
    await this.requirePermission(req, context, EDIT_PERMISSION, route);
    const values: Record<string, unknown> = {};
    if (body.code !== undefined) values.code = body.code;
    if (body.name !== undefined) {
      values.name_en = body.name.en;
      values.name_ar = body.name.ar;
    }
    if (body.active !== undefined) values.active = body.active;
    return this.mutate(req, context, 'PATCH', route, 'journal.update', {
      actor_identity: req.auth.keycloakUserId,
      journal_id: journalId,
      expected_version: expectedVersion,
      values,
    }) as Promise<JournalMutationResultDto>;
  }

  private async mutate(
    req: TenantScopedRequest,
    context: AccountingOdooContext,
    method: 'POST' | 'PATCH' | 'PUT',
    route: string,
    action: AccountingAction,
    envelope: MutationEnvelope,
  ): Promise<JournalMutationResultDto | CurrencyConfigurationMutationResultDto> {
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
      method,
      route,
      action,
      idempotencyKey,
      requestFingerprint: fingerprintOf({ action, ...envelope }),
      requestPayload: envelope,
    });
    if (handoff.state === AccountingMutationHandoffState.AUDITED) {
      return this.result(handoff, context.companyUuid, correlationId, true, action);
    }
    if (handoff.state === AccountingMutationHandoffState.REJECTED) {
      this.translateKnownFault(new Error(handoff.lastErrorCode ?? 'ACCOUNTING_REJECTED'));
    }

    let upstream: unknown = handoff.finalResponse;
    if (handoff.state === AccountingMutationHandoffState.PENDING) {
      try {
        upstream = await this.execute(handoff, context, envelope);
        this.assertMutation(upstream, context.companyUuid, action);
        await this.handoffs.markOdooCommitted(handoff.id, upstream);
      } catch (error) {
        if (this.isOpaqueDenial(error)) {
          await this.audit.recordPreDomainDenial({
            operationUuid: handoff.id,
            tenantId: context.tenantId,
            companyUuid: context.companyUuid,
            actorAccountId: context.accountId,
            route,
            reason: 'company_scope_denied',
          });
        }
        const errorCode = deterministicAccountingFaultCode(error);
        if (errorCode) {
          await this.handoffs.markRejected(handoff.id, errorCode);
          this.translateKnownFault(error);
        }
        await this.handoffs.scheduleRetryBackoff(handoff.id, 1_000);
        throw new ServiceUnavailableException(
          'Accounting mutation could not be confirmed and will be recovered automatically',
        );
      }
    }

    this.assertMutation(upstream, context.companyUuid, action);
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
    return this.result(committed, context.companyUuid, correlationId, false, action);
  }

  private execute(
    handoff: AccountingMutationHandoff,
    context: AccountingOdooContext,
    envelope: MutationEnvelope,
  ): Promise<unknown> {
    if (handoff.action === 'currency.put') {
      return this.odoo.executeKw(
        context.db,
        context.uid,
        context.password,
        'kemfai.account.currency.config',
        'kemfai_put_currency_configuration',
        [
          context.companyId,
          envelope.currency_code,
          handoff.id,
          envelope.actor_identity,
          envelope.if_match,
          envelope.values,
        ],
        this.kwargs(context),
      );
    }
    const args =
      handoff.action === 'journal.create'
        ? [handoff.id, envelope.actor_identity, envelope.values]
        : [
            envelope.journal_id,
            handoff.id,
            envelope.actor_identity,
            envelope.expected_version,
            envelope.values,
            context.companyId,
          ];
    return this.odoo.executeKw(
      context.db,
      context.uid,
      context.password,
      'account.journal',
      handoff.action === 'journal.create' ? 'kemfai_create_journal' : 'kemfai_update_journal',
      args,
      this.kwargs(context),
    );
  }

  private result(
    handoff: AccountingMutationHandoff,
    companyUuid: string,
    correlationId: string,
    replayed: boolean,
    action: AccountingAction,
  ): JournalMutationResultDto | CurrencyConfigurationMutationResultDto {
    this.assertMutation(handoff.finalResponse, companyUuid, action);
    const receipt = {
      operationId: handoff.id,
      auditEventId: handoff.finalResponse.audit_event_id!,
      correlationId,
      replayed,
    };
    if (action === 'currency.put') {
      return { ...receipt, resource: this.toCurrency(handoff.finalResponse, companyUuid) };
    }
    return { ...receipt, resource: this.toJournal(handoff.finalResponse, companyUuid) };
  }

  private toJournal(value: unknown, companyUuid: string): JournalDto {
    this.assertJournal(value, companyUuid);
    return {
      id: value.id,
      companyId: companyUuid,
      code: value.code,
      name: { en: value.name_en, ar: value.name_ar },
      journalType: value.type,
      active: value.active,
      version: value.version,
      selectableForDrafts: value.active,
    };
  }

  private toCurrency(value: unknown, companyUuid: string): CurrencyConfigurationDto {
    this.assertCurrency(value, companyUuid);
    return {
      id: value.id,
      companyId: companyUuid,
      currencyCode: value.currency_code,
      nativeDecimalPlaces: value.native_decimal_places,
      nativeMetadataVersion: value.native_metadata_version,
      isBase: value.is_base,
      enabled: value.enabled,
      version: value.version,
    };
  }

  private assertMutation(
    value: unknown,
    companyUuid: string,
    action: AccountingAction,
  ): asserts value is UpstreamJournal | UpstreamCurrency {
    if (action === 'currency.put') this.assertCurrency(value, companyUuid);
    else this.assertJournal(value, companyUuid);
    if (!this.isUuid(value.audit_event_id)) this.invalidData();
  }

  private assertCurrency(value: unknown, companyUuid: string): asserts value is UpstreamCurrency {
    const row = value as Partial<UpstreamCurrency> | null;
    if (
      !row ||
      typeof row !== 'object' ||
      !this.isUuid(row.id) ||
      row.company_id !== companyUuid ||
      !/^[A-Z]{3}$/.test(row.currency_code ?? '') ||
      !Number.isInteger(row.native_decimal_places) ||
      (row.native_decimal_places ?? -1) < 0 ||
      (row.native_decimal_places ?? 13) > 12 ||
      typeof row.native_metadata_version !== 'string' ||
      !row.native_metadata_version ||
      typeof row.is_base !== 'boolean' ||
      typeof row.enabled !== 'boolean' ||
      !Number.isInteger(row.version) ||
      (row.version ?? 0) < 1
    )
      this.invalidData();
  }

  private assertJournal(value: unknown, companyUuid: string): asserts value is UpstreamJournal {
    const row = value as Partial<UpstreamJournal> | null;
    if (
      !row ||
      typeof row !== 'object' ||
      !this.isUuid(row.id) ||
      row.company_id !== companyUuid ||
      typeof row.code !== 'string' ||
      typeof row.name_en !== 'string' ||
      typeof row.name_ar !== 'string' ||
      row.type !== 'general' ||
      typeof row.active !== 'boolean' ||
      !Number.isInteger(row.version) ||
      (row.version ?? 0) < 1
    ) {
      this.invalidData();
    }
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

  private translateKnownFault(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('PRECONDITION_FAILED')) {
      throw new PreconditionFailedException('PRECONDITION_FAILED');
    }
    if (message.includes('STALE_VERSION')) throw new PreconditionFailedException('STALE_VERSION');
    if (/(?:JOURNAL|CURRENCY)_(?:NOT_FOUND|SCOPE_DENIED)/.test(message)) {
      throw new NotFoundException('Accounting resource was not found');
    }
    if (/HISTORY_PROTECTED|EXISTS|CONFLICT/.test(message)) {
      throw new ConflictException(message.match(/[A-Z][A-Z_]+/)?.[0] ?? 'JOURNAL_CONFLICT');
    }
    throw new UnprocessableEntityException(
      message.match(/(?:JOURNAL|CURRENCY(?:_CONFIGURATION)?|NATIVE|BASE)_[A-Z_]+/)?.[0] ??
        'ACCOUNTING_VALIDATION_FAILED',
    );
  }

  private isOpaqueDenial(error: unknown): boolean {
    return /(?:JOURNAL|CURRENCY)_(?:NOT_FOUND|SCOPE_DENIED)/.test(
      error instanceof Error ? error.message : String(error),
    );
  }

  private isKnownFault(error: unknown): boolean {
    return deterministicAccountingFaultCode(error) !== null;
  }

  private kwargs(context: AccountingOdooContext) {
    return {
      context: { allowed_company_ids: [context.companyId], force_company: context.companyId },
    };
  }

  private header(req: TenantScopedRequest, name: string): string | undefined {
    const value = req.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  }

  private invalidPage(): never {
    throw new InternalServerErrorException('Accounting engine returned invalid journal page');
  }

  private invalidData(): never {
    throw new InternalServerErrorException('Accounting engine returned invalid journal data');
  }

  private isUuid(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    );
  }
}
