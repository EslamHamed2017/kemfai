import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';

export enum SupportAccessGranteeRole {
  BILLING_ADMIN = 'BillingAdmin',
  SUPPORT = 'Support',
  SUPER_ADMIN = 'SuperAdmin',
  CUSTOMER_SUCCESS = 'CustomerSuccess',
  TECHNICAL_ADMIN = 'TechnicalAdmin',
}

/**
 * Customer-authorized, time-bounded internal access to a tenant's workspace
 * (data-model.md "SupportAccessGrant", FR-039–FR-041). `expiresAt` is mandatory — enforced
 * `NOT NULL` at the database level (T013 migration) — so a grant can never be created open-ended.
 */
@Entity({ name: 'support_access_grant' })
export class SupportAccessGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ name: 'granted_by', type: 'uuid' })
  grantedBy: string;

  @ManyToOne(() => Account, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'granted_by' })
  grantedByAccount: Account;

  @Column({
    name: 'grantee_role',
    type: 'enum',
    enum: SupportAccessGranteeRole,
    enumName: 'support_access_grantee_role_enum',
  })
  granteeRole: SupportAccessGranteeRole;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
