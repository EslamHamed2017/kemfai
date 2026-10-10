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
import { Subscription } from './subscription.entity';

export enum PaymentSubmissionStatus {
  PENDING_REVIEW = 'PendingReview',
  APPROVED = 'Approved',
  REJECTED = 'Rejected',
  MORE_INFO_REQUESTED = 'MoreInfoRequested',
}

export interface PaymentSubmissionStatusHistoryEntry {
  status: PaymentSubmissionStatus;
  changedAt: string;
  changedBy: string | null;
  notes: string | null;
  /** Immutable evidence snapshot for customer submission/resubmission transitions (T062). */
  bankReference?: string;
  proofObjectKey?: string;
}

/**
 * A customer's claim of payment for one billing period (data-model.md "PaymentSubmission",
 * FR-032–FR-036). `subscriptionId` is enforced by a composite FK against `subscription(tenant_id,
 * id)` at the DB level (T012 migration) — a row can never pair this tenant's `tenantId` with
 * another tenant's `subscriptionId`. `statusHistory` is append-only, enforced by a `BEFORE UPDATE`
 * trigger in the same migration, not by application code alone (Constitution Principle VII).
 */
@Entity({ name: 'payment_submission' })
export class PaymentSubmission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ name: 'subscription_id', type: 'uuid' })
  subscriptionId: string;

  @ManyToOne(() => Subscription, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'subscription_id' })
  subscription: Subscription;

  @Column({ name: 'billing_period_start', type: 'date' })
  billingPeriodStart: string;

  @Column({ name: 'billing_period_end', type: 'date' })
  billingPeriodEnd: string;

  @Column({ name: 'amount', type: 'numeric', precision: 12, scale: 2 })
  amount: string;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency: string;

  @Column({ name: 'bank_reference', type: 'text', unique: true })
  bankReference: string;

  @Column({ name: 'proof_object_key', type: 'text' })
  proofObjectKey: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: PaymentSubmissionStatus,
    enumName: 'payment_submission_status_enum',
    default: PaymentSubmissionStatus.PENDING_REVIEW,
  })
  status: PaymentSubmissionStatus;

  @CreateDateColumn({ name: 'submitted_at', type: 'timestamptz' })
  submittedAt: Date;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @ManyToOne(() => Account, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'reviewed_by' })
  reviewedByAccount: Account | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ name: 'decision_notes', type: 'text', nullable: true })
  decisionNotes: string | null;

  @Column({ name: 'status_history', type: 'jsonb', default: () => "'[]'" })
  statusHistory: PaymentSubmissionStatusHistoryEntry[];
}
