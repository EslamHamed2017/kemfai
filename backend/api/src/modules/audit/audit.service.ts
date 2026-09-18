import { Injectable } from '@nestjs/common';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import controlDataSource from '../../database/data-source';
import { AuditActorType, AuditEvent } from './entities/audit-event.entity';

export interface AuditEventInput {
  actorType: AuditActorType;
  actorId: string | null;
  tenantId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

/**
 * Append-only audit writer (T017 groundwork for the full AuditService catalog in T019).
 * Every field required by FR-008 is carried by {@link AuditEventInput}. This method NEVER
 * swallows write failures: an error from the insert propagates to the caller, which is
 * what lets TenantScopeGuard fail closed (an unaudited tenant_access.denied_cross_tenant
 * denial must never be served). Immutability of the table itself is enforced at the
 * Postgres privilege level by the T014 migration.
 */
@Injectable()
export class AuditService {
  async append(event: AuditEventInput): Promise<void> {
    const repo = controlDataSource.getRepository(AuditEvent);
    await repo.insert({
      actorType: event.actorType,
      actorId: event.actorId,
      tenantId: event.tenantId,
      action: event.action,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      occurredAt: event.occurredAt,
      payload: event.payload,
      createdAt: new Date(),
    } as QueryDeepPartialEntity<AuditEvent>);
  }
}
