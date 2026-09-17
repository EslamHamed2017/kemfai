import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A sellable plan (data-model.md "Plan"). `name` is display-only — no code outside seed/test data
 * may branch on it (Constitution P-07); every entitlement/trial/auto-restriction decision reads
 * PlanFeatureEntitlement / PlanSetting / EntitlementDefault instead (FR-030/FR-030a).
 */
@Entity({ name: 'plan' })
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'name', type: 'text' })
  name: string;

  @Column({ name: 'published', type: 'boolean', default: false })
  published: boolean;

  @Column({ name: 'monthly_price', type: 'numeric', precision: 12, scale: 2 })
  monthlyPrice: string;

  @Column({ name: 'annual_price', type: 'numeric', precision: 12, scale: 2 })
  annualPrice: string;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
