import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SupportAccessGrant } from './support-access-grant.entity';

/**
 * One row per support-access attempt, allowed or denied (data-model.md "SupportAccessUsage",
 * FR-041). `usedBy` stores a `kemfai-internal` Keycloak user id as a bare uuid — there is no
 * local internal-user table, mirroring `Account.keycloakUserId`'s convention.
 */
@Entity({ name: 'support_access_usage' })
export class SupportAccessUsage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'grant_id', type: 'uuid' })
  grantId: string;

  @ManyToOne(() => SupportAccessGrant, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'grant_id' })
  grant: SupportAccessGrant;

  @Column({ name: 'used_by', type: 'uuid' })
  usedBy: string;

  @CreateDateColumn({ name: 'used_at', type: 'timestamptz' })
  usedAt: Date;

  @Column({ name: 'action_summary', type: 'text' })
  actionSummary: string;

  @Column({ name: 'was_denied', type: 'boolean', default: false })
  wasDenied: boolean;

  @Column({ name: 'denial_reason', type: 'text', nullable: true })
  denialReason: string | null;
}
