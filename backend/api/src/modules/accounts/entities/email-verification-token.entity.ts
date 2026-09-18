import { Column, Entity, Generated, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * T033 — one row per issued email-verification link (FR-019/FR-021). The raw token is
 * never persisted: only its SHA-256 hex digest (`tokenHash`), so consuming
 * `POST /accounts/verify-email` is a lookup by hash while a database leak yields no
 * usable links. `issuanceSequence` (bigserial) makes "the most recently issued link"
 * for an account a provable max() — the sole row a verification may honor (Edge Cases:
 * re-issue supersedes all earlier links regardless of their expiry/consumption state).
 * Single-use semantics live in `consumedAt`; `expiresAt` carries the link TTL.
 */
@Entity({ name: 'email_verification_token' })
@Index('uq_email_verification_token_hash', ['tokenHash'], { unique: true })
@Index('ix_email_verification_token_account', ['accountId'])
export class EmailVerificationToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  @Column({ name: 'token_version', type: 'uuid' })
  tokenVersion: string;

  @Column({ name: 'issuance_sequence', type: 'bigint' })
  @Generated('increment')
  issuanceSequence: string;

  @Column({ name: 'issued_at', type: 'timestamptz', default: () => 'now()' })
  issuedAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;
}
