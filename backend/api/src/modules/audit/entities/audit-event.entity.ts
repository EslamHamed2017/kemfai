import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Tenant } from '../../tenants/entities/tenant.entity';

export enum AuditActorType {
  ACCOUNT = 'account',
  INTERNAL_USER = 'internal_user',
  SYSTEM = 'system',
}

/**
 * Platform-wide, append-only audit log (data-model.md "AuditEvent", FR-007–FR-009).
 * Immutability is enforced at the Postgres privilege level by the T014 migration (UPDATE/DELETE
 * revoked from the `kemfai_api` role), not by application convention — this entity intentionally
 * has no update-oriented helpers.
 */
@Entity({ name: 'audit_event' })
export class AuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @Column({
    name: 'actor_type',
    type: 'enum',
    enum: AuditActorType,
    enumName: 'audit_actor_type_enum',
  })
  actorType: AuditActorType;

  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant | null;

  @Column({ name: 'action', type: 'text' })
  action: string;

  @Column({ name: 'subject_type', type: 'text' })
  subjectType: string;

  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  @Column({ name: 'payload', type: 'jsonb' })
  payload: Record<string, unknown>;

  /**
   * Durable "ensure exactly once" anchor (T055 remediation): non-null only for call sites
   * that need DB-enforced idempotent append (`uq_audit_event_dedupe_key`, partial unique
   * index over non-null values) — see `AuditService.append`'s `dedupeKey` parameter. Every
   * pre-existing action leaves this NULL and is therefore unconstrained, exactly as before.
   */
  @Column({ name: 'dedupe_key', type: 'text', nullable: true })
  dedupeKey: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
