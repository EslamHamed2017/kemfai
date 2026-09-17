import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';

export enum TenantStatus {
  PENDING = 'Pending',
  CREATING = 'Creating',
  READY = 'Ready',
  FAILED = 'Failed',
}

/**
 * The tenant/workspace registry entry (data-model.md "Tenant"). One row per verified Account
 * (1:1, unique + FK on `account_id`) — the unique constraint is what makes provisioning
 * idempotent at the database level (T008 acceptance criteria), not merely application logic.
 */
@Entity({ name: 'tenant' })
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'account_id', type: 'uuid', unique: true })
  accountId: string;

  @ManyToOne(() => Account, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'account_id' })
  account: Account;

  @Column({
    name: 'status',
    type: 'enum',
    enum: TenantStatus,
    enumName: 'tenant_status_enum',
    default: TenantStatus.PENDING,
  })
  status: TenantStatus;

  @Column({ name: 'odoo_db_name', type: 'text', nullable: true })
  odooDbName: string | null;

  @Column({ name: 'minio_bucket', type: 'text', nullable: true })
  minioBucket: string | null;

  @Column({ name: 'provisioning_attempts', type: 'int', default: 0 })
  provisioningAttempts: number;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'ready_at', type: 'timestamptz', nullable: true })
  readyAt: Date | null;
}
