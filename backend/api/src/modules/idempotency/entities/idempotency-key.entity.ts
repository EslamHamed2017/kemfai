import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum IdempotencyRecordStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
}

/**
 * One claimed (scope, idempotency_key, method, path) slot (T020, Constitution Principle
 * VII). `fingerprint` is a SHA-256 hash of the request body — the only signal that
 * distinguishes "the same logical retry" from "a different caller/request that happens to
 * reuse this key", since `scope` deliberately does not encode anything as weak as a client
 * IP (see `idempotency.interceptor.ts`). Rows are claimed `pending` *before* the mutating
 * handler runs and flipped to `completed` only after it succeeds, so a persisted claim
 * always predates the side effect it guards.
 */
@Entity({ name: 'idempotency_key' })
export class IdempotencyKeyRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'scope', type: 'text' })
  scope: string;

  @Column({ name: 'idempotency_key', type: 'text' })
  idempotencyKey: string;

  @Column({ name: 'method', type: 'text' })
  method: string;

  @Column({ name: 'path', type: 'text' })
  path: string;

  @Column({ name: 'fingerprint', type: 'text' })
  fingerprint: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: IdempotencyRecordStatus,
    enumName: 'idempotency_record_status_enum',
  })
  status: IdempotencyRecordStatus;

  @Column({ name: 'response_body', type: 'jsonb', nullable: true })
  responseBody: unknown;

  @Column({ name: 'locked_at', type: 'timestamptz' })
  lockedAt: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
