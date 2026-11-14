import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import {
  AccountingMutationHandoff,
  AccountingMutationHandoffState,
} from './entities/accounting-mutation-handoff.entity';

export type CreateAccountingMutationHandoff = {
  tenantId: string;
  companyUuid: string;
  actorAccountId: string;
  principalIdentity: string;
  odooDbName: string;
  odooCompanyId: number;
  callerScope: string;
  method: string;
  route: string;
  action: string;
  idempotencyKey: string;
  requestFingerprint: string;
  requestPayload?: Record<string, unknown>;
};

type HandoffRow = {
  id: string;
  tenant_id: string;
  company_uuid: string;
  actor_account_id: string;
  principal_identity: string;
  odoo_db_name: string;
  odoo_company_id: number;
  caller_scope: string;
  method: string;
  route: string;
  action: string;
  idempotency_key: string;
  request_fingerprint: string;
  request_payload_redacted: Record<string, unknown>;
  state: AccountingMutationHandoffState;
  final_response: Record<string, unknown> | null;
  retry_count: number;
  next_attempt_at: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
  odoo_committed_at: Date | null;
  audited_at: Date | null;
};

@Injectable()
export class AccountingMutationHandoffService {
  async findOrCreateHandoff(
    input: CreateAccountingMutationHandoff,
  ): Promise<AccountingMutationHandoff> {
    const method = input.method.trim().toUpperCase();
    const redacted = this.redactPayload(input.requestPayload ?? {});
    const insertedResult: unknown = await controlDataSource.query(
      `INSERT INTO "accounting_mutation_handoff" (
         "tenant_id", "company_uuid", "actor_account_id", "principal_identity",
         "odoo_db_name", "odoo_company_id", "caller_scope", "method", "route", "action", "idempotency_key",
         "request_fingerprint", "request_payload_redacted"
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT ON CONSTRAINT "uq_accounting_mutation_handoff_scoped_key" DO NOTHING
       RETURNING *`,
      [
        input.tenantId,
        input.companyUuid,
        input.actorAccountId,
        input.principalIdentity,
        input.odooDbName,
        input.odooCompanyId,
        input.callerScope,
        method,
        input.route,
        input.action,
        input.idempotencyKey,
        input.requestFingerprint,
        JSON.stringify(redacted),
      ],
    );
    const inserted = this.rows(insertedResult);
    if (inserted[0]) return this.map(inserted[0]);

    const existing = await controlDataSource.query<HandoffRow[]>(
      `SELECT * FROM "accounting_mutation_handoff"
        WHERE "tenant_id" = $1 AND "company_uuid" = $2 AND "actor_account_id" = $3
          AND "method" = $4 AND "route" = $5 AND "idempotency_key" = $6`,
      [
        input.tenantId,
        input.companyUuid,
        input.actorAccountId,
        method,
        input.route,
        input.idempotencyKey,
      ],
    );
    if (!existing[0]) {
      throw new ConflictException('Idempotency claim could not be resolved');
    }
    if (existing[0].request_fingerprint !== input.requestFingerprint) {
      throw new ConflictException('Idempotency key was already used for another request');
    }
    return this.map(existing[0]);
  }

  async findById(id: string): Promise<AccountingMutationHandoff> {
    const rows = await controlDataSource.query<HandoffRow[]>(
      'SELECT * FROM "accounting_mutation_handoff" WHERE "id" = $1',
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Accounting mutation handoff was not found');
    return this.map(rows[0]);
  }

  async markRejected(id: string, errorCode: string): Promise<void> {
    const normalizedCode = errorCode.trim().slice(0, 128) || 'ACCOUNTING_REJECTED';
    const result: unknown = await controlDataSource.query(
      `UPDATE "accounting_mutation_handoff"
          SET "state" = 'rejected', "last_error_code" = $2,
              "lease_owner" = NULL, "lease_expires_at" = NULL,
              "next_attempt_at" = NULL, "updated_at" = now()
        WHERE "id" = $1 AND "state" IN ('pending', 'rejected')
        RETURNING *`,
      [id, normalizedCode],
    );
    const rows = this.rows(result);
    if (!rows[0] && (await this.findById(id)).state !== AccountingMutationHandoffState.REJECTED) {
      throw new ConflictException('Invalid accounting mutation rejection transition');
    }
  }

  async markOdooCommitted(id: string, finalResponse: unknown): Promise<void> {
    const result: unknown = await controlDataSource.query(
      `UPDATE "accounting_mutation_handoff"
          SET "state" = 'odoo_committed', "final_response" = $2::jsonb,
              "odoo_committed_at" = COALESCE("odoo_committed_at", now()),
              "lease_owner" = NULL, "lease_expires_at" = NULL,
              "next_attempt_at" = NULL, "last_error_code" = NULL, "updated_at" = now()
        WHERE "id" = $1 AND "state" IN ('pending', 'odoo_committed')
        RETURNING *`,
      [id, JSON.stringify(finalResponse)],
    );
    const rows = this.rows(result);
    if (!rows[0] && (await this.findById(id)).state !== AccountingMutationHandoffState.AUDITED) {
      throw new ConflictException('Invalid accounting mutation state transition');
    }
  }

  async markAudited(id: string): Promise<void> {
    const result: unknown = await controlDataSource.query(
      `UPDATE "accounting_mutation_handoff"
          SET "state" = 'audited', "audited_at" = COALESCE("audited_at", now()),
              "lease_owner" = NULL, "lease_expires_at" = NULL,
              "next_attempt_at" = NULL, "last_error_code" = NULL, "updated_at" = now()
        WHERE "id" = $1 AND "state" IN ('odoo_committed', 'audited')
        RETURNING *`,
      [id],
    );
    const rows = this.rows(result);
    if (!rows[0])
      throw new ConflictException('Mutation must be committed before audit convergence');
  }

  async scheduleRetryBackoff(id: string, delayMs: number): Promise<void> {
    const boundedDelay = Math.max(1_000, Math.min(delayMs, 60_000));
    await controlDataSource.query(
      `UPDATE "accounting_mutation_handoff"
          SET "next_attempt_at" = now() + ($2::integer * interval '1 millisecond'),
              "lease_owner" = NULL, "lease_expires_at" = NULL, "updated_at" = now()
        WHERE "id" = $1 AND "state" IN ('pending', 'odoo_committed')`,
      [id, boundedDelay],
    );
  }

  async claimBatchForRecovery(
    owner: string,
    durationMs: number,
    size: number,
  ): Promise<AccountingMutationHandoff[]> {
    const boundedDuration = Math.max(1_000, Math.min(durationMs, 60_000));
    const boundedSize = Math.max(1, Math.min(size, 100));
    const result: unknown = await controlDataSource.query(
      `WITH candidates AS (
         SELECT "id" FROM "accounting_mutation_handoff"
          WHERE "state" IN ('pending', 'odoo_committed')
            AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= now())
            AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= now())
          ORDER BY "next_attempt_at" NULLS FIRST, "created_at", "id"
          LIMIT $3 FOR UPDATE SKIP LOCKED
       )
       UPDATE "accounting_mutation_handoff" AS handoff
          SET "lease_owner" = $1,
              "lease_expires_at" = now() + ($2::integer * interval '1 millisecond'),
              "retry_count" = handoff."retry_count" + 1,
              "updated_at" = now()
         FROM candidates
        WHERE handoff."id" = candidates."id"
       RETURNING handoff.*`,
      [owner, boundedDuration, boundedSize],
    );
    return this.rows(result).map((row) => this.map(row));
  }

  private redactPayload(value: Record<string, unknown>): Record<string, unknown> {
    const sensitive = /password|token|secret|credential|authorization/i;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitive.test(key))
        .map(([key, item]) => [
          key,
          item && typeof item === 'object' && !Array.isArray(item)
            ? this.redactPayload(item as Record<string, unknown>)
            : item,
        ]),
    );
  }

  private rows(result: unknown): HandoffRow[] {
    if (!Array.isArray(result)) return [];
    return Array.isArray(result[0]) ? (result[0] as HandoffRow[]) : (result as HandoffRow[]);
  }

  private map(row: HandoffRow): AccountingMutationHandoff {
    return Object.assign(new AccountingMutationHandoff(), {
      id: row.id,
      tenantId: row.tenant_id,
      companyUuid: row.company_uuid,
      actorAccountId: row.actor_account_id,
      principalIdentity: row.principal_identity,
      odooDbName: row.odoo_db_name,
      odooCompanyId: row.odoo_company_id,
      callerScope: row.caller_scope,
      method: row.method,
      route: row.route,
      action: row.action,
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      requestPayloadRedacted: row.request_payload_redacted,
      state: row.state,
      finalResponse: row.final_response,
      retryCount: row.retry_count,
      nextAttemptAt: row.next_attempt_at,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      lastErrorCode: row.last_error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      odooCommittedAt: row.odoo_committed_at,
      auditedAt: row.audited_at,
    });
  }
}
