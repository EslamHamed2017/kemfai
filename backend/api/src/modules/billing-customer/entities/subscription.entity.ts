import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Account } from '../../accounts/entities/account.entity';
import { Plan } from '../../entitlements/entities/plan.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';

export enum SubscriptionBillingCycle {
  MONTHLY = 'monthly',
  ANNUAL = 'annual',
}

export enum SubscriptionStatus {
  PENDING_ACTIVATION = 'PendingActivation',
  ACTIVE = 'Active',
  SUSPENDED = 'Suspended',
  CANCELLED = 'Cancelled',
}

/**
 * The billing relationship for a tenant (data-model.md "Subscription"). One row per Tenant
 * (1:1, unique + FK on `tenant_id`, T011 acceptance criteria) — renewal for a new period updates
 * `current_period_start/end` on this same row rather than inserting a new Subscription row.
 */
@Entity({ name: 'subscription' })
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid', unique: true })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ name: 'plan_id', type: 'uuid' })
  planId: string;

  @ManyToOne(() => Plan, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

  @Column({
    name: 'billing_cycle',
    type: 'enum',
    enum: SubscriptionBillingCycle,
    enumName: 'subscription_billing_cycle_enum',
  })
  billingCycle: SubscriptionBillingCycle;

  @Column({
    name: 'status',
    type: 'enum',
    enum: SubscriptionStatus,
    enumName: 'subscription_status_enum',
    default: SubscriptionStatus.PENDING_ACTIVATION,
  })
  status: SubscriptionStatus;

  @Column({ name: 'current_period_start', type: 'date' })
  currentPeriodStart: string;

  @Column({ name: 'current_period_end', type: 'date' })
  currentPeriodEnd: string;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt: Date | null;

  @Column({ name: 'activated_by', type: 'uuid', nullable: true })
  activatedBy: string | null;

  @ManyToOne(() => Account, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'activated_by' })
  activatedByAccount: Account | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
