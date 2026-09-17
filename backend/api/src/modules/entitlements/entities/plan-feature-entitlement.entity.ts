import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Feature } from './feature.entity';
import { Plan } from './plan.entity';

/**
 * The single source of truth for what a plan grants (data-model.md "PlanFeatureEntitlement",
 * FR-030). Composite PK (plan_id, feature_key) — this is the *only* table any module-selection or
 * usage-limit check may read.
 */
@Entity({ name: 'plan_feature_entitlement' })
export class PlanFeatureEntitlement {
  @PrimaryColumn({ name: 'plan_id', type: 'uuid' })
  planId: string;

  @PrimaryColumn({ name: 'feature_key', type: 'text' })
  featureKey: string;

  @ManyToOne(() => Plan, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

  @ManyToOne(() => Feature, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'feature_key', referencedColumnName: 'key' })
  feature: Feature;

  @Column({ name: 'enabled', type: 'boolean', default: false })
  enabled: boolean;

  @Column({ name: 'limit_value', type: 'numeric', nullable: true })
  limitValue: string | null;
}
