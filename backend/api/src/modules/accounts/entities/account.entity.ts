import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum BillingCycle {
  MONTHLY = 'monthly',
  ANNUAL = 'annual',
}

export enum Locale {
  EN = 'en',
  AR = 'ar',
}

/**
 * Identity record backing a Keycloak `kemfai-customers` user (data-model.md "Account").
 * State is one-way `Unverified -> Verified`, modeled by `emailVerified` alone — there is no
 * separate status column (T007 acceptance criteria).
 */
@Entity({ name: 'account' })
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'keycloak_user_id', type: 'uuid' })
  keycloakUserId: string;

  @Column({ name: 'email', type: 'citext', unique: true })
  email: string;

  @Column({ name: 'email_verified', type: 'boolean', default: false })
  emailVerified: boolean;

  @Column({ name: 'mfa_enrolled', type: 'boolean', default: false })
  mfaEnrolled: boolean;

  @Column({ name: 'selected_plan_id', type: 'uuid', nullable: true })
  selectedPlanId: string | null;

  @Column({
    name: 'selected_billing_cycle',
    type: 'enum',
    enum: BillingCycle,
    enumName: 'account_selected_billing_cycle_enum',
    nullable: true,
  })
  selectedBillingCycle: BillingCycle | null;

  @Column({
    name: 'preferred_locale',
    type: 'enum',
    enum: Locale,
    enumName: 'account_preferred_locale_enum',
    nullable: true,
  })
  preferredLocale: Locale | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
