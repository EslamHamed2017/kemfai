import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { Plan } from './plan.entity';

/**
 * Per-plan FR-030a overrides (data-model.md "PlanSetting"). `trialWindowDays` /
 * `autoRestrictUnpaid` are nullable with NO in-column default — null means "use
 * EntitlementDefault", and only EntitlementsService (T010) may resolve that fallback (I1
 * remediation, analysis.md).
 */
@Entity({ name: 'plan_setting' })
export class PlanSetting {
  @PrimaryColumn({ name: 'plan_id', type: 'uuid' })
  planId: string;

  @OneToOne(() => Plan, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

  @Column({ name: 'trial_window_days', type: 'int', nullable: true })
  trialWindowDays: number | null;

  @Column({ name: 'auto_restrict_unpaid', type: 'boolean', nullable: true })
  autoRestrictUnpaid: boolean | null;
}
