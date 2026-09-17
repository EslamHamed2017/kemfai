import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The platform-wide fallback singleton (data-model.md "EntitlementDefault"). Enforced as a
 * singleton at the DB level (`CHECK (id = 1)` on the primary key) and seeded by
 * CreateEntitlements1789620000000's migration itself — not by a separate seed step — with
 * `defaultTrialWindowDays=14` and `defaultAutoRestrictUnpaid=true`.
 */
@Entity({ name: 'entitlement_default' })
export class EntitlementDefault {
  @PrimaryColumn({ name: 'id', type: 'smallint' })
  id: number;

  @Column({ name: 'default_trial_window_days', type: 'int' })
  defaultTrialWindowDays: number;

  @Column({ name: 'default_auto_restrict_unpaid', type: 'boolean' })
  defaultAutoRestrictUnpaid: boolean;
}
