import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum CompanyMutationAction {
  SETUP_COMPLETE = 'setup.complete',
  SETTINGS_UPDATE = 'settings.update',
}

export enum CompanyMutationHandoffState {
  PENDING = 'pending',
  ODOO_COMMITTED = 'odoo_committed',
  AUDITED = 'audited',
  FAILED = 'failed',
}

/**
 * T055 arbiter binding resolution, point 1 — the control-plane durable record committed
 * BEFORE the Odoo RPC for a company mutation that must converge to exactly one business
 * event even across a lost response, a process crash, or an audit-store failure. This row
 * — never the HTTP request/response cycle — is the source of truth an autonomous worker
 * (`CompanyMutationRecoveryWorker`) recovers from without requiring another client call.
 *
 * `id` IS the immutable operation UUID (point 1's "immutable operation UUID" requirement):
 * generated once at handoff creation, passed into the Odoo RPC, and used as the Odoo-side
 * receipt key and the audit dedupe key — one identifier threaded through every layer.
 *
 * Two distinct uniqueness regimes (point 1's last bullet), both enforced by partial unique
 * indexes in the migration, never by application-level check-then-insert:
 * - `setup.complete` is capped at one handoff per tenant forever (AC3.7's "exactly one
 *   company.setup.completed event per actual company completion" — reconciling
 *   operation-UUID dedupe with that requirement means completion requests resolve to this
 *   SAME stable row, not a fresh one per retry).
 * - `settings.update` is capped at one handoff per (callerScope, tenantId, method, route,
 *   idempotencyKey) only when a client-supplied Idempotency-Key is present — absent a key,
 *   every call is a distinct new intent (point 5) and gets its own row/operation UUID.
 */
@Entity({ name: 'company_mutation_handoff' })
export class CompanyMutationHandoff {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    name: 'action',
    type: 'enum',
    enum: CompanyMutationAction,
    enumName: 'company_mutation_action_enum',
  })
  action: CompanyMutationAction;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  /** Original accepted-request actor — never overwritten by a later retrying caller. */
  @Column({ name: 'actor_account_id', type: 'uuid' })
  actorAccountId: string;

  @Column({ name: 'principal_identity', type: 'text' })
  principalIdentity: string;

  @Column({ name: 'odoo_db_name', type: 'text' })
  odooDbName: string;

  @Column({ name: 'odoo_company_id', type: 'int' })
  odooCompanyId: number;

  @Column({ name: 'request_fingerprint', type: 'text' })
  requestFingerprint: string;

  /**
   * The original request's logical payload (empty object for setup completion, which
   * takes no body; `body.values` for a settings update) — stored so
   * `CompanyMutationRecoveryWorker` can replay the Odoo RPC even when the process never
   * reached that call at all (crash between this row's commit and the RPC), not only
   * when Odoo already committed.
   */
  @Column({ name: 'request_payload', type: 'jsonb' })
  requestPayload: Record<string, unknown>;

  /** Original occurrence time — the timestamp the audit event must preserve on recovery. */
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @Column({ name: 'idempotency_key', type: 'text', nullable: true })
  idempotencyKey: string | null;

  /** Authenticated-caller+tenant scope (same shape as `IdempotencyKeyInterceptor`'s scopeOf). */
  @Column({ name: 'caller_scope', type: 'text', nullable: true })
  callerScope: string | null;

  @Column({ name: 'method', type: 'text', nullable: true })
  method: string | null;

  @Column({ name: 'route', type: 'text', nullable: true })
  route: string | null;

  @Column({
    name: 'state',
    type: 'enum',
    enum: CompanyMutationHandoffState,
    enumName: 'company_mutation_handoff_state_enum',
  })
  state: CompanyMutationHandoffState;

  @Column({ name: 'retry_count', type: 'int', default: 0 })
  retryCount: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt: Date | null;

  /** The Odoo RPC's result (or receipt replay) — never mutated once the state is `audited`. */
  @Column({ name: 'final_response', type: 'jsonb', nullable: true })
  finalResponse: unknown;

  @Column({ name: 'lease_owner', type: 'text', nullable: true })
  leaseOwner: string | null;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
