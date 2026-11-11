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
  DimensionDefinitionCreateDto,
  DimensionDefinitionDto,
  DimensionDefinitionUpdateDto,
  DimensionMutationResultDto,
  DimensionPageDto,
  DimensionRuleCreateDto,
  DimensionRuleDto,
  DimensionRuleUpdateDto,
  DimensionValueCreateDto,
  DimensionValueDto,
  DimensionValueUpdateDto,
} from '../dto/dimension.dto';
import {
  AccountingMutationHandoff,
  AccountingMutationHandoffState,
} from '../entities/accounting-mutation-handoff.entity';

const BASE = '/v1/accounting';
const VIEW = 'accounting.coa.view';
const CREATE = 'accounting.coa.create';
const EDIT = 'accounting.coa.edit';
type Kind = 'definition' | 'value' | 'rule';
type Action = `dimension.${Kind}.${'create' | 'update'}`;
type Envelope = {
  actor_identity: string;
  resource_id?: string;
  expected_version?: number;
  values: Record<string, unknown>;
};
type Upstream = Record<string, unknown> & {
  id: string;
  active: boolean;
  version: number;
  audit_event_id?: string;
};

@Injectable()
export class DimensionsService {
  constructor(
    private readonly context: AccountingOdooContextService,
    private readonly odoo: OdooRpcService,
    private readonly handoffs: AccountingMutationHandoffService,
    private readonly audit: AccountingPlatformAuditService,
  ) {}

  listDefinitions(req: TenantScopedRequest, companyUuid: string, filters: { active?: boolean }) {
    return this.list(req, companyUuid, 'definition', filters) as Promise<
      DimensionPageDto<DimensionDefinitionDto>
    >;
  }
  listValues(
    req: TenantScopedRequest,
    companyUuid: string,
    filters: { cursor?: string; limit: number; definitionId?: string; active?: boolean },
  ) {
    return this.list(req, companyUuid, 'value', filters) as Promise<
      DimensionPageDto<DimensionValueDto>
    >;
  }
  listRules(
    req: TenantScopedRequest,
    companyUuid: string,
    filters: { accountId?: string; transactionType?: string; active?: boolean },
  ) {
    return this.list(req, companyUuid, 'rule', filters) as Promise<
      DimensionPageDto<DimensionRuleDto>
    >;
  }

  createDefinition(
    req: TenantScopedRequest,
    companyUuid: string,
    body: DimensionDefinitionCreateDto,
  ) {
    return this.create(req, companyUuid, 'definition', {
      key: body.key,
      kind: body.kind ?? 'custom',
      name_en: body.name.en,
      name_ar: body.name.ar,
      active: body.active ?? true,
    }) as Promise<DimensionMutationResultDto<DimensionDefinitionDto>>;
  }
  createValue(req: TenantScopedRequest, companyUuid: string, body: DimensionValueCreateDto) {
    return this.create(req, companyUuid, 'value', {
      definition_public_id: body.definitionId,
      code: body.code,
      name_en: body.name.en,
      name_ar: body.name.ar,
      active: body.active ?? true,
    }) as Promise<DimensionMutationResultDto<DimensionValueDto>>;
  }
  createRule(req: TenantScopedRequest, companyUuid: string, body: DimensionRuleCreateDto) {
    return this.create(req, companyUuid, 'rule', {
      account_public_id: body.accountId ?? false,
      transaction_type_key: body.transactionType ?? false,
      dimension_definition_public_id: body.dimensionDefinitionId,
      requirement: body.requirement,
      effective_from: body.effectiveFrom ?? new Date().toISOString().slice(0, 10),
      effective_to: body.effectiveTo ?? false,
      active: body.active ?? true,
    }) as Promise<DimensionMutationResultDto<DimensionRuleDto>>;
  }

  updateDefinition(
    req: TenantScopedRequest,
    companyUuid: string,
    id: string,
    version: number,
    body: DimensionDefinitionUpdateDto,
  ) {
    const values: Record<string, unknown> = {};
    if (body.name) Object.assign(values, { name_en: body.name.en, name_ar: body.name.ar });
    if (body.active !== undefined) values.active = body.active;
    return this.update(req, companyUuid, 'definition', id, version, values) as Promise<
      DimensionMutationResultDto<DimensionDefinitionDto>
    >;
  }
  updateValue(
    req: TenantScopedRequest,
    companyUuid: string,
    id: string,
    version: number,
    body: DimensionValueUpdateDto,
  ) {
    const values: Record<string, unknown> = {};
    if (body.code !== undefined) values.code = body.code;
    if (body.name) Object.assign(values, { name_en: body.name.en, name_ar: body.name.ar });
    if (body.active !== undefined) values.active = body.active;
    return this.update(req, companyUuid, 'value', id, version, values) as Promise<
      DimensionMutationResultDto<DimensionValueDto>
    >;
  }
  updateRule(
    req: TenantScopedRequest,
    companyUuid: string,
    id: string,
    version: number,
    body: DimensionRuleUpdateDto,
  ) {
    const values: Record<string, unknown> = {};
    if (body.requirement !== undefined) values.requirement = body.requirement;
    if (body.effectiveFrom !== undefined) values.effective_from = body.effectiveFrom ?? false;
    if (body.effectiveTo !== undefined) values.effective_to = body.effectiveTo ?? false;
    if (body.active !== undefined) values.active = body.active;
    return this.update(req, companyUuid, 'rule', id, version, values) as Promise<
      DimensionMutationResultDto<DimensionRuleDto>
    >;
  }

  private async list(
    req: TenantScopedRequest,
    companyUuid: string,
    kind: Kind,
    filters: Record<string, unknown>,
  ): Promise<DimensionPageDto<unknown>> {
    const ctx = await this.context.resolve(req, companyUuid);
    await this.requirePermission(req, ctx, VIEW, this.route(kind));
    try {
      const result = await this.odoo.executeKw(
        ctx.db,
        ctx.uid,
        ctx.password,
        this.model(kind),
        `kemfai_list_dimension_${this.plural(kind)}`,
        [ctx.companyId, filters],
        this.kwargs(ctx),
      );
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new Error('invalid');
      const page = result as { items?: unknown; next_cursor?: unknown };
      if (
        !Array.isArray(page.items) ||
        !(page.next_cursor == null || this.isUuid(page.next_cursor))
      )
        throw new Error('invalid');
      return {
        items: page.items.map((item) => this.toDto(kind, item, ctx.companyUuid)),
        nextCursor: (page.next_cursor as string | null) ?? null,
      };
    } catch (error) {
      if (this.isKnownFault(error)) this.translate(error);
      if (error instanceof Error && error.message === 'invalid')
        throw new InternalServerErrorException('Accounting engine returned invalid dimension page');
      throw error;
    }
  }

  private async create(
    req: TenantScopedRequest,
    companyUuid: string,
    kind: Kind,
    values: Record<string, unknown>,
  ): Promise<DimensionMutationResultDto<unknown>> {
    const ctx = await this.context.resolve(req, companyUuid);
    const route = this.route(kind);
    await this.requirePermission(req, ctx, CREATE, route);
    return this.mutate(
      req,
      ctx,
      'POST',
      route,
      `dimension.${kind}.create`,
      { actor_identity: req.auth.keycloakUserId, values: { ...values, company_id: ctx.companyId } },
      kind,
    );
  }
  private async update(
    req: TenantScopedRequest,
    companyUuid: string,
    kind: Kind,
    id: string,
    version: number,
    values: Record<string, unknown>,
  ): Promise<DimensionMutationResultDto<unknown>> {
    const ctx = await this.context.resolve(req, companyUuid);
    const route = `${this.route(kind)}/${id}`;
    await this.requirePermission(req, ctx, EDIT, route);
    return this.mutate(
      req,
      ctx,
      'PATCH',
      route,
      `dimension.${kind}.update`,
      {
        actor_identity: req.auth.keycloakUserId,
        resource_id: id,
        expected_version: version,
        values,
      },
      kind,
    );
  }

  private async mutate(
    req: TenantScopedRequest,
    ctx: AccountingOdooContext,
    method: 'POST' | 'PATCH',
    route: string,
    action: Action,
    envelope: Envelope,
    kind: Kind,
  ): Promise<DimensionMutationResultDto<unknown>> {
    const idempotencyKey = this.header(req, 'idempotency-key');
    if (!idempotencyKey) throw new ConflictException('Idempotency-Key is required');
    const correlationId = this.header(req, 'x-correlation-id');
    if (!correlationId)
      throw new UnprocessableEntityException('Correlation identifier is required');
    const handoff = await this.handoffs.findOrCreateHandoff({
      tenantId: ctx.tenantId,
      companyUuid: ctx.companyUuid,
      actorAccountId: ctx.accountId,
      principalIdentity: req.auth.keycloakUserId,
      odooDbName: ctx.db,
      odooCompanyId: ctx.companyId,
      callerScope: `keycloak:${req.auth.keycloakUserId}:tenant:${ctx.tenantId}`,
      method,
      route,
      action,
      idempotencyKey,
      requestFingerprint: fingerprintOf({ action, ...envelope }),
      requestPayload: envelope,
    });
    if (handoff.state === AccountingMutationHandoffState.AUDITED)
      return this.result(handoff, kind, ctx.companyUuid, correlationId, true);
    if (handoff.state === AccountingMutationHandoffState.REJECTED)
      this.translate(new Error(handoff.lastErrorCode ?? 'ACCOUNTING_REJECTED'));
    let upstream: unknown = handoff.finalResponse;
    if (handoff.state === AccountingMutationHandoffState.PENDING) {
      try {
        upstream = await this.execute(handoff, ctx, envelope, kind);
        this.assertUpstream(upstream);
        await this.handoffs.markOdooCommitted(handoff.id, upstream);
      } catch (error) {
        if (this.isOpaqueDenial(error)) {
          await this.audit.recordPreDomainDenial({
            operationUuid: handoff.id,
            tenantId: ctx.tenantId,
            companyUuid: ctx.companyUuid,
            actorAccountId: ctx.accountId,
            route,
            reason: 'company_scope_denied',
          });
        }
        const errorCode = deterministicAccountingFaultCode(error);
        if (errorCode) {
          await this.handoffs.markRejected(handoff.id, errorCode);
          this.translate(error);
        }
        await this.handoffs.scheduleRetryBackoff(handoff.id, 1_000);
        throw new ServiceUnavailableException(
          'Accounting mutation could not be confirmed and will be recovered automatically',
        );
      }
    }
    this.assertUpstream(upstream);
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
    return this.result(committed, kind, ctx.companyUuid, correlationId, false);
  }

  private execute(
    handoff: AccountingMutationHandoff,
    ctx: AccountingOdooContext,
    envelope: Envelope,
    kind: Kind,
  ) {
    const suffix = kind === 'definition' ? 'definition' : kind;
    const args = handoff.action.endsWith('.create')
      ? [handoff.id, envelope.actor_identity, envelope.values]
      : [
          envelope.resource_id,
          handoff.id,
          envelope.actor_identity,
          envelope.expected_version,
          envelope.values,
          ctx.companyId,
        ];
    return this.odoo.executeKw(
      ctx.db,
      ctx.uid,
      ctx.password,
      this.model(kind),
      `kemfai_${handoff.action.endsWith('.create') ? 'create' : 'update'}_dimension_${suffix}`,
      args,
      this.kwargs(ctx),
    );
  }

  private result(
    handoff: AccountingMutationHandoff,
    kind: Kind,
    companyUuid: string,
    correlationId: string,
    replayed: boolean,
  ): DimensionMutationResultDto<unknown> {
    this.assertUpstream(handoff.finalResponse);
    return {
      operationId: handoff.id,
      auditEventId: handoff.finalResponse.audit_event_id!,
      correlationId,
      replayed,
      resource: this.toDto(kind, handoff.finalResponse, companyUuid),
    };
  }
  private toDto(
    kind: Kind,
    value: unknown,
    companyUuid: string,
  ): DimensionDefinitionDto | DimensionValueDto | DimensionRuleDto {
    this.assertUpstream(value);
    const common = {
      id: value.id,
      companyId: companyUuid,
      active: value.active,
      version: value.version,
    };
    if (kind === 'definition') {
      if (
        typeof value.key !== 'string' ||
        !['built_in', 'custom', 'tag'].includes(String(value.kind)) ||
        typeof value.name_en !== 'string' ||
        typeof value.name_ar !== 'string'
      )
        this.invalid();
      return {
        ...common,
        key: value.key as string,
        kind: value.kind as DimensionDefinitionDto['kind'],
        name: { en: value.name_en as string, ar: value.name_ar as string },
      };
    }
    if (kind === 'value') {
      if (
        !this.isUuid(value.definition_id) ||
        typeof value.code !== 'string' ||
        typeof value.name_en !== 'string' ||
        typeof value.name_ar !== 'string'
      )
        this.invalid();
      return {
        ...common,
        definitionId: value.definition_id,
        code: value.code as string,
        name: { en: value.name_en as string, ar: value.name_ar as string },
      };
    }
    if (
      !(value.account_id == null || this.isUuid(value.account_id)) ||
      !(value.transaction_type == null || typeof value.transaction_type === 'string') ||
      !this.isUuid(value.dimension_definition_id) ||
      !['required', 'optional', 'prohibited'].includes(String(value.requirement))
    )
      this.invalid();
    return {
      ...common,
      accountId: value.account_id as string | null,
      transactionType: value.transaction_type as string | null,
      dimensionDefinitionId: value.dimension_definition_id,
      requirement: value.requirement as DimensionRuleDto['requirement'],
      effectiveFrom: value.effective_from as string | null,
      effectiveTo: value.effective_to as string | null,
    };
  }
  private assertUpstream(value: unknown): asserts value is Upstream {
    const row = value as Partial<Upstream> | null;
    if (
      !row ||
      typeof row !== 'object' ||
      !this.isUuid(row.id) ||
      typeof row.active !== 'boolean' ||
      !Number.isInteger(row.version) ||
      (row.version ?? 0) < 1 ||
      (row.audit_event_id !== undefined && !this.isUuid(row.audit_event_id))
    )
      this.invalid();
  }
  private invalid(): never {
    throw new InternalServerErrorException('Accounting engine returned invalid dimension data');
  }
  private async requirePermission(
    req: TenantScopedRequest,
    ctx: AccountingOdooContext,
    permission: string,
    route: string,
  ) {
    if (req.auth.roles.includes(permission)) return;
    await this.audit.recordPreDomainDenial({
      operationUuid: randomUUID(),
      tenantId: ctx.tenantId,
      companyUuid: ctx.companyUuid,
      actorAccountId: ctx.accountId,
      route,
      reason: 'permission_denied',
    });
    throw new ForbiddenException('Accounting access denied');
  }
  private translate(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('STALE_VERSION')) throw new PreconditionFailedException('STALE_VERSION');
    if (/NOT_FOUND|SCOPE_DENIED/.test(message))
      throw new NotFoundException('Dimension resource was not found');
    if (/EXISTS|OVERLAP|CONFLICT|HISTORY_PROTECTED/.test(message))
      throw new ConflictException(message.match(/[A-Z][A-Z_]+/)?.[0] ?? 'DIMENSION_CONFLICT');
    throw new UnprocessableEntityException(
      message.match(/DIMENSION_[A-Z_]+/)?.[0] ?? 'DIMENSION_VALIDATION_FAILED',
    );
  }
  private isOpaqueDenial(error: unknown) {
    return /DIMENSION_(?:[A-Z]+_)*(?:NOT_FOUND|SCOPE_DENIED)/.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  private isKnownFault(error: unknown): boolean {
    return deterministicAccountingFaultCode(error) !== null;
  }
  private route(kind: Kind) {
    return `${BASE}/dimension-${this.plural(kind).replace('definitions', 'definitions')}`;
  }
  private plural(kind: Kind) {
    return kind === 'definition' ? 'definitions' : `${kind}s`;
  }
  private model(kind: Kind) {
    return `kemfai.dimension.${kind}`;
  }
  private kwargs(ctx: AccountingOdooContext) {
    return { context: { allowed_company_ids: [ctx.companyId], force_company: ctx.companyId } };
  }
  private header(req: TenantScopedRequest, name: string) {
    const value = req.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  }
  private isUuid(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    );
  }
}
