import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuditActorType } from '../audit/entities/audit-event.entity';
import { AccountingMutationHandoff } from './entities/accounting-mutation-handoff.entity';

export type AccountingPreDomainDenial = {
  operationUuid: string;
  tenantId: string;
  companyUuid: string;
  actorAccountId: string;
  route: string;
  reason: 'permission_denied' | 'company_scope_denied';
  occurredAt?: Date;
};

@Injectable()
export class AccountingPlatformAuditService {
  constructor(private readonly audit: AuditService) {}

  /** The caller may return this result only after this promise resolves. */
  async recordAccountingMutation(
    handoff: AccountingMutationHandoff & {
      operationUuid?: string;
      result?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const operationUuid = handoff.operationUuid ?? handoff.id;
    const finalResponse = handoff.result ?? handoff.finalResponse;
    if (!finalResponse) {
      throw new Error('Committed accounting mutation has no durable final response');
    }
    await this.audit.append({
      actorType: AuditActorType.ACCOUNT,
      actorId: handoff.actorAccountId,
      tenantId: handoff.tenantId,
      action: handoff.action,
      subjectType: this.subjectType(handoff.action),
      subjectId: this.subjectId(handoff),
      occurredAt: handoff.odooCommittedAt ?? handoff.createdAt,
      payload: {
        operation_uuid: operationUuid,
        company_uuid: handoff.companyUuid,
        state: 'odoo_committed',
      },
      dedupeKey: `accounting.mutation:${operationUuid}`,
    });
    return finalResponse;
  }

  /** Persist an opaque, non-domain denial before the caller emits its denial response. */
  async recordPreDomainDenial(input: AccountingPreDomainDenial): Promise<void> {
    await this.audit.append({
      actorType: AuditActorType.ACCOUNT,
      actorId: input.actorAccountId,
      tenantId: input.tenantId,
      action: 'accounting.access.denied',
      subjectType: 'company',
      subjectId: input.companyUuid,
      occurredAt: input.occurredAt ?? new Date(),
      payload: {
        operation_uuid: input.operationUuid,
        company_uuid: input.companyUuid,
        route: input.route,
        reason: input.reason,
      },
      dedupeKey: `accounting.denial:${input.operationUuid}`,
    });
  }

  private subjectType(action: string): string {
    const segment = action.split('.')[0]?.trim();
    return segment || 'accounting_resource';
  }

  private subjectId(handoff: AccountingMutationHandoff): string {
    const response = handoff.finalResponse ?? {};
    const resource = response.resource;
    if (resource && typeof resource === 'object' && 'id' in resource) {
      const id = (resource as { id?: unknown }).id;
      if (typeof id === 'string' && this.isUuid(id)) return id;
    }
    const directId = response.id;
    return typeof directId === 'string' && this.isUuid(directId) ? directId : handoff.id;
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}
