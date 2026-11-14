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
  AccountCreateDto,
  AccountDto,
  AccountPageDto,
  AccountUpdateDto,
  MutationAccountResultDto,
} from '../dto/account.dto';
import {
  AccountingMutationHandoff,
  AccountingMutationHandoffState,
} from '../entities/accounting-mutation-handoff.entity';

const ACCOUNTS_ROUTE = '/v1/accounting/accounts';
const VIEW_PERMISSION = 'accounting.coa.view';
const CREATE_PERMISSION = 'accounting.coa.create';
const EDIT_PERMISSION = 'accounting.coa.edit';

type AccountAction = 'account.create' | 'account.update' | 'account.deactivate';

type UpstreamAccountResult = {
  id: string;
  code: string;
  name_en: string;
  name_ar: string;
  account_type: string;
  node_kind: 'parent' | 'posting';
  parent_id: string | null;
  active: boolean;
  version: number;
  audit_event_id: string;
};

type MutationEnvelope = {
  actor_identity: string;
  account_id?: string;
  expected_version?: number;
  values?: Record<string, unknown>;
};

@Injectable()
export class AccountsService {
  constructor(
    private readonly context: AccountingOdooContextService,
    private readonly odoo: OdooRpcService,
    private readonly handoffs: AccountingMutationHandoffService,
    private readonly audit: AccountingPlatformAuditService,
  ) {}

  async list(
    req: TenantScopedRequest,
    companyUuid: string,
    filters: {
      cursor?: string;
      limit: number;
      active?: boolean;
      nodeKind?: 'parent' | 'posting';
      search?: string;
    },
  ): Promise<AccountPageDto> {
    const context = await this.context.resolve(req, companyUuid);
    await this.requirePermission(req, context, VIEW_PERMISSION, ACCOUNTS_ROUTE);
    const result = await this.odoo.executeKw(
      context.db,
      context.uid,
      context.password,
      'account.account',
      'kemfai_list_accounts',
      [context.companyId, filters],
      { context: { allowed_company_ids: [context.companyId], force_company: context.companyId } },
    );
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new InternalServerErrorException('Accounting engine returned invalid account page');
    }
    const page = result as { items?: unknown; next_cursor?: unknown };
    if (
      !Array.isArray(page.items) ||
      !(
        page.next_cursor === null ||
        page.next_cursor === undefined ||
        this.isUuid(page.next_cursor)
      )
    ) {
      throw new InternalServerErrorException('Accounting engine returned invalid account page');
    }
    return {
      items: page.items.map((item) => {
        this.assertAccount(item);
        return this.toAccount(item, context.companyUuid);
      }),
      nextCursor: (page.next_cursor as string | null | undefined) ?? null,
    };
  }

  async get(req: TenantScopedRequest, companyUuid: string, accountId: string): Promise<AccountDto> {
    const context = await this.context.resolve(req, companyUuid);
    const route = `${ACCOUNTS_ROUTE}/${accountId}`;
    await this.requirePermission(req, context, VIEW_PERMISSION, route);
    try {
      const result = await this.odoo.executeKw(
        context.db,
        context.uid,
        context.password,
        'account.account',
        'kemfai_read_account',
        [accountId, context.companyId],
        { context: { allowed_company_ids: [context.companyId], force_company: context.companyId } },
      );
      this.assertAccount(result);
      return this.toAccount(result, context.companyUuid);
    } catch (error) {
      if (this.isOpaqueReadDenial(error)) {
        await this.audit.recordPreDomainDenial({
          operationUuid: randomUUID(),
          tenantId: context.tenantId,
          companyUuid: context.companyUuid,
          actorAccountId: context.accountId,
          route,
          reason: 'company_scope_denied',
        });
      }
      if (this.isKnownFault(error)) this.translateKnownFault(error);
      throw error;
    }
  }

  async create(
    req: TenantScopedRequest,
    companyUuid: string,
    body: AccountCreateDto,
  ): Promise<MutationAccountResultDto> {
    const context = await this.context.resolve(req, companyUuid);
    await this.requirePermission(req, context, CREATE_PERMISSION, ACCOUNTS_ROUTE);
    const envelope: MutationEnvelope = {
      actor_identity: req.auth.keycloakUserId,
      values: this.createValues(body, context.companyId),
    };
    return this.mutate(req, context, 'POST', ACCOUNTS_ROUTE, 'account.create', envelope);
  }

  async update(
    req: TenantScopedRequest,
    companyUuid: string,
    accountId: string,
    expectedVersion: number,
    body: AccountUpdateDto,
  ): Promise<MutationAccountResultDto> {
    const context = await this.context.resolve(req, companyUuid);
    const route = `${ACCOUNTS_ROUTE}/${accountId}`;
    await this.requirePermission(req, context, EDIT_PERMISSION, route);
    const envelope: MutationEnvelope = {
      actor_identity: req.auth.keycloakUserId,
      account_id: accountId,
      expected_version: expectedVersion,
      values: this.updateValues(body),
    };
    return this.mutate(req, context, 'PATCH', route, 'account.update', envelope);
  }

  async deactivate(
    req: TenantScopedRequest,
    companyUuid: string,
    accountId: string,
    expectedVersion: number,
  ): Promise<MutationAccountResultDto> {
    const context = await this.context.resolve(req, companyUuid);
    const route = `${ACCOUNTS_ROUTE}/${accountId}`;
    await this.requirePermission(req, context, EDIT_PERMISSION, route);
    return this.mutate(req, context, 'PATCH', route, 'account.deactivate', {
      actor_identity: req.auth.keycloakUserId,
      account_id: accountId,
      expected_version: expectedVersion,
    });
  }

  private async mutate(
    req: TenantScopedRequest,
    context: AccountingOdooContext,
    method: 'POST' | 'PATCH',
    route: string,
    action: AccountAction,
    envelope: MutationEnvelope,
  ): Promise<MutationAccountResultDto> {
    const idempotencyKey = this.header(req, 'idempotency-key');
    if (!idempotencyKey) throw new ConflictException('Idempotency-Key is required');
    const correlationId = this.header(req, 'x-correlation-id');
    if (!correlationId)
      throw new UnprocessableEntityException('Correlation identifier is required');
    const fingerprint = fingerprintOf({ action, ...envelope });
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
      requestFingerprint: fingerprint,
      requestPayload: envelope as Record<string, unknown>,
    });

    if (handoff.state === AccountingMutationHandoffState.AUDITED) {
      return this.toResult(handoff, context.companyUuid, correlationId, true);
    }

    if (handoff.state === AccountingMutationHandoffState.REJECTED) {
      this.translateKnownFault(new Error(handoff.lastErrorCode ?? 'ACCOUNTING_REJECTED'));
    }

    let upstream: unknown = handoff.finalResponse;
    if (handoff.state === AccountingMutationHandoffState.PENDING) {
      try {
        upstream = await this.execute(handoff, context, envelope);
        this.assertUpstream(upstream);
        await this.handoffs.markOdooCommitted(handoff.id, upstream);
      } catch (error) {
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
    return this.toResult(committed, context.companyUuid, correlationId, false);
  }

  private execute(
    handoff: AccountingMutationHandoff,
    context: AccountingOdooContext,
    envelope: MutationEnvelope,
  ): Promise<unknown> {
    let method: string;
    let args: unknown[];
    if (handoff.action === 'account.create') {
      method = 'kemfai_create_account';
      args = [handoff.id, envelope.actor_identity, envelope.values];
    } else if (handoff.action === 'account.update') {
      method = 'kemfai_update_account';
      args = [
        envelope.account_id,
        handoff.id,
        envelope.actor_identity,
        envelope.expected_version,
        envelope.values,
        context.companyId,
      ];
    } else {
      method = 'kemfai_deactivate_account';
      args = [
        envelope.account_id,
        handoff.id,
        envelope.actor_identity,
        envelope.expected_version,
        context.companyId,
      ];
    }
    return this.odoo.executeKw(
      context.db,
      context.uid,
      context.password,
      'account.account',
      method,
      args,
      { context: { allowed_company_ids: [context.companyId], force_company: context.companyId } },
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

  private createValues(body: AccountCreateDto, companyId: number): Record<string, unknown> {
    return {
      company_id: companyId,
      code: body.code,
      name_en: body.name.en,
      name_ar: body.name.ar,
      account_type: body.accountType,
      kemfai_node_kind: body.nodeKind,
      kemfai_parent_id: body.parentId ?? false,
      active: body.active ?? true,
    };
  }

  private updateValues(body: AccountUpdateDto): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    if (body.code !== undefined) values.code = body.code;
    if (body.name !== undefined) {
      values.name_en = body.name.en;
      values.name_ar = body.name.ar;
    }
    if (body.accountType !== undefined) values.account_type = body.accountType;
    if (body.nodeKind !== undefined) values.kemfai_node_kind = body.nodeKind;
    if (body.parentId !== undefined) values.kemfai_parent_id = body.parentId ?? false;
    if (body.active !== undefined) values.active = body.active;
    return values;
  }

  private toResult(
    handoff: AccountingMutationHandoff,
    companyUuid: string,
    correlationId: string,
    replayed: boolean,
  ): MutationAccountResultDto {
    this.assertUpstream(handoff.finalResponse);
    return {
      operationId: handoff.id,
      auditEventId: handoff.finalResponse.audit_event_id,
      correlationId,
      replayed,
      resource: this.toAccount(handoff.finalResponse, companyUuid),
    };
  }

  private toAccount(value: UpstreamAccountResult, companyUuid: string): AccountDto {
    return {
      id: value.id,
      companyId: companyUuid,
      code: value.code,
      name: { en: value.name_en, ar: value.name_ar },
      accountType: value.account_type,
      nodeKind: value.node_kind,
      parentId: value.parent_id,
      active: value.active,
      version: value.version,
      selectableForDraftLines: value.node_kind === 'posting' && value.active,
    };
  }

  private assertUpstream(value: unknown): asserts value is UpstreamAccountResult {
    this.assertAccount(value);
    if (!this.isUuid((value as Partial<UpstreamAccountResult>).audit_event_id)) {
      throw new InternalServerErrorException('Accounting engine returned invalid mutation data');
    }
  }

  private assertAccount(value: unknown): asserts value is UpstreamAccountResult {
    const row = value as Partial<UpstreamAccountResult> | null;
    if (
      !row ||
      typeof row !== 'object' ||
      !this.isUuid(row.id) ||
      typeof row.code !== 'string' ||
      typeof row.name_en !== 'string' ||
      typeof row.name_ar !== 'string' ||
      typeof row.account_type !== 'string' ||
      !['parent', 'posting'].includes(row.node_kind ?? '') ||
      !(row.parent_id === null || this.isUuid(row.parent_id)) ||
      typeof row.active !== 'boolean' ||
      !Number.isInteger(row.version) ||
      (row.version ?? 0) < 1
    ) {
      throw new InternalServerErrorException('Accounting engine returned invalid account data');
    }
  }

  private isOpaqueReadDenial(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /ACCOUNT_NOT_FOUND|ACCOUNT_SCOPE_DENIED/.test(message);
  }

  private isKnownFault(error: unknown): boolean {
    return deterministicAccountingFaultCode(error) !== null;
  }

  private translateKnownFault(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('STALE_VERSION')) throw new PreconditionFailedException('STALE_VERSION');
    if (message.includes('ACCOUNT_NOT_FOUND')) throw new NotFoundException('Account was not found');
    if (message.includes('ACCOUNT_SCOPE_DENIED'))
      throw new NotFoundException('Account was not found');
    if (message.includes('HISTORY_PROTECTED')) throw new ConflictException('HISTORY_PROTECTED');
    throw new UnprocessableEntityException(
      message.match(/(?:ACCOUNT|HISTORY)_[A-Z_]+/)?.[0] ?? 'ACCOUNT_VALIDATION_FAILED',
    );
  }

  private header(req: TenantScopedRequest, name: string): string | undefined {
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
