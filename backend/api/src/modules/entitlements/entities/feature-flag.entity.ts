import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { Feature } from './feature.entity';

/**
 * Config-driven module-completeness gate (data-model.md "FeatureFlag", Constitution Principle VI —
 * "incomplete modules MUST sit behind feature flags"). PK is `feature_key`, the same stable
 * identifier PlanFeatureEntitlement joins against, so this is the same config-driven structure as
 * FR-030a rather than a second ad-hoc mechanism (T099).
 */
@Entity({ name: 'feature_flag' })
export class FeatureFlag {
  @PrimaryColumn({ name: 'feature_key', type: 'text' })
  featureKey: string;

  @OneToOne(() => Feature, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'feature_key', referencedColumnName: 'key' })
  feature: Feature;

  @Column({ name: 'enabled', type: 'boolean', default: false })
  enabled: boolean;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes: string | null;
}
