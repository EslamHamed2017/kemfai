import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum AccountingMutationHandoffState {
  PENDING = 'pending',
  REJECTED = 'rejected',
  ODOO_COMMITTED = 'odoo_committed',
  AUDITED = 'audited',
}

@Entity({ name: 'accounting_mutation_handoff' })
@Index(
  'uq_accounting_mutation_handoff_scoped_key',
  ['tenantId', 'companyUuid', 'actorAccountId', 'method', 'route', 'idempotencyKey'],
  { unique: true },
)
export class AccountingMutationHandoff {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'company_uuid' })
  companyUuid!: string;

  @Column('uuid', { name: 'actor_account_id' })
  actorAccountId!: string;

  @Column('text', { name: 'principal_identity' })
  principalIdentity!: string;

  @Column('text', { name: 'odoo_db_name' })
  odooDbName!: string;

  @Column('integer', { name: 'odoo_company_id' })
  odooCompanyId!: number;

  @Column('text', { name: 'caller_scope' })
  callerScope!: string;

  @Column('varchar', { length: 10 })
  method!: string;

  @Column('text')
  route!: string;

  @Column('text')
  action!: string;

  @Column('text', { name: 'idempotency_key' })
  idempotencyKey!: string;

  @Column('text', { name: 'request_fingerprint' })
  requestFingerprint!: string;

  @Column('jsonb', { name: 'request_payload_redacted', default: () => "'{}'::jsonb" })
  requestPayloadRedacted!: Record<string, unknown>;

  @Column('varchar', { length: 32, default: AccountingMutationHandoffState.PENDING })
  state!: AccountingMutationHandoffState;

  @Column('jsonb', { name: 'final_response', nullable: true })
  finalResponse!: Record<string, unknown> | null;

  @Column('integer', { name: 'retry_count', default: 0 })
  retryCount!: number;

  @Column('timestamptz', { name: 'next_attempt_at', nullable: true })
  nextAttemptAt!: Date | null;

  @Column('text', { name: 'lease_owner', nullable: true })
  leaseOwner!: string | null;

  @Column('timestamptz', { name: 'lease_expires_at', nullable: true })
  leaseExpiresAt!: Date | null;

  @Column('text', { name: 'last_error_code', nullable: true })
  lastErrorCode!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column('timestamptz', { name: 'odoo_committed_at', nullable: true })
  odooCommittedAt!: Date | null;

  @Column('timestamptz', { name: 'audited_at', nullable: true })
  auditedAt!: Date | null;
}
