import { ConflictException, Injectable, InternalServerErrorException } from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import {
  CompanyMutationAction,
  CompanyMutationHandoffState,
} from './entities/company-mutation-handoff.entity';

export interface CompanyMutationHandoffRow {
  id: string;
  action: CompanyMutationAction;
  tenantId: string;
  actorAccountId: string;
  principalIdentity: string;
  odooDbName: string;
  odooCompanyId: number;
  requestFingerprint: string;
  requestPayload: Record<string, unknown>;
  occurredAt: Date;
  idempotencyKey: string | null;
  callerScope: string | null;
  method: string | null;
  route: string | null;
  state: CompanyMutationHandoffState;
  retryCount: number;
  finalResponse: unknown;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
}

export interface CompletionHandoffInput {
  tenantId: string;
  actorAccountId: string;
  principalIdentity: string;
  odooDbName: string;
  odooCompanyId: number;
  requestFingerprint: string;
  requestPayload: Record<string, unknown>;
}

export interface SettingsHandoffInput extends CompletionHandoffInput {
  idempotencyKey: string | null;
  callerScope: string | null;
  method: string;
  route: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapRow(row: any): CompanyMutationHandoffRow {
  return {
    id: row.id as string,
    action: row.action as CompanyMutationAction,
    tenantId: row.tenant_id as string,
    actorAccountId: row.actor_account_id as string,
    principalIdentity: row.principal_identity as string,
    odooDbName: row.odoo_db_name as string,
    odooCompanyId: row.odoo_company_id as number,
    requestFingerprint: row.request_fingerprint as string,
    requestPayload: (row.request_payload as Record<string, unknown>) ?? {},
    occurredAt: new Date(row.occurred_at as string),
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    callerScope: (row.caller_scope as string | null) ?? null,
    method: (row.method as string | null) ?? null,
    route: (row.route as string | null) ?? null,
    state: row.state as CompanyMutationHandoffState,
    retryCount: row.retry_count as number,
    finalResponse: row.final_response,
    leaseOwner: (row.lease_owner as string | null) ?? null,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at as string) : null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * T055 arbiter binding resolution, point 1 — raw-SQL data access for
 * `company_mutation_handoff` (same idiom as `IdempotencyService` for `idempotency_key`:
 * short, independent statements, no transaction held open across a handler's own
 * execution). This is the control-plane durability layer `CompanySetupService` and
 * `CompanySettingsService` commit to BEFORE calling Odoo, and the ONLY source
 * `CompanyMutationRecoveryWorker` reads from to recover without another client request.
 */
@Injectable()
export class CompanyMutationHandoffService {
  /**
   * At most one `setup.complete` handoff ever exists per tenant (DB partial unique
   * index `uq_company_mutation_handoff_completion`) — every completion request, whatever
   * client key (or none) it carries, resolves to this SAME row. This is what reconciles
   * operation-UUID dedupe with AC3.7's "exactly one company.setup.completed event per
   * actual company completion", even under separate concurrent HTTP requests.
   */
  async findOrCreateCompletionHandoff(
    input: CompletionHandoffInput,
  ): Promise<CompanyMutationHandoffRow> {
    const inserted = await controlDataSource.query(
      `INSERT INTO "company_mutation_handoff"
         ("action","tenant_id","actor_account_id","principal_identity","odoo_db_name",
          "odoo_company_id","request_fingerprint","request_payload","occurred_at","state")
       VALUES ('setup.complete',$1,$2,$3,$4,$5,$6,$7, now(), 'pending')
       ON CONFLICT ("tenant_id") WHERE "action" = 'setup.complete' DO NOTHING
       RETURNING *`,
      [
        input.tenantId,
        input.actorAccountId,
        input.principalIdentity,
        input.odooDbName,
        input.odooCompanyId,
        input.requestFingerprint,
        JSON.stringify(input.requestPayload ?? {}),
      ],
    );
    if (inserted[0]) {
      return mapRow(inserted[0]);
    }
    const existing = await controlDataSource.query(
      `SELECT * FROM "company_mutation_handoff" WHERE "tenant_id" = $1 AND "action" = 'setup.complete'`,
      [input.tenantId],
    );
    if (!existing[0]) {
      throw new InternalServerErrorException('Completion handoff race produced no row');
    }
    return mapRow(existing[0]);
  }

  /**
   * With a client `Idempotency-Key`, the same (callerScope, tenant, method, route, key)
   * tuple resolves to the SAME handoff — same fingerprint replays its stored result,
   * different fingerprint 409s (arbiter resolution point 5). Without a key, every call
   * gets a brand-new handoff/operation UUID: a distinct new intent, never collapsed with
   * any other call (the partial unique index only covers non-null keys, so two null-key
   * inserts never conflict).
   */
  async findOrCreateSettingsHandoff(
    input: SettingsHandoffInput,
  ): Promise<CompanyMutationHandoffRow> {
    const inserted = await controlDataSource.query(
      `INSERT INTO "company_mutation_handoff"
         ("action","tenant_id","actor_account_id","principal_identity","odoo_db_name",
          "odoo_company_id","request_fingerprint","request_payload","occurred_at",
          "idempotency_key","caller_scope","method","route","state")
       VALUES ('settings.update',$1,$2,$3,$4,$5,$6,$7, now(), $8,$9,$10,$11,'pending')
       ON CONFLICT ("caller_scope","tenant_id","method","route","idempotency_key")
         WHERE "idempotency_key" IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        input.tenantId,
        input.actorAccountId,
        input.principalIdentity,
        input.odooDbName,
        input.odooCompanyId,
        input.requestFingerprint,
        JSON.stringify(input.requestPayload ?? {}),
        input.idempotencyKey,
        input.callerScope,
        input.method,
        input.route,
      ],
    );
    if (inserted[0]) {
      return mapRow(inserted[0]);
    }

    // Conflict: an existing handoff already owns this scoped key (only possible when
    // idempotencyKey was non-null — a null key can never match the partial index).
    const existingRows = await controlDataSource.query(
      `SELECT * FROM "company_mutation_handoff"
       WHERE "caller_scope" = $1 AND "tenant_id" = $2 AND "method" = $3 AND "route" = $4
         AND "idempotency_key" = $5`,
      [input.callerScope, input.tenantId, input.method, input.route, input.idempotencyKey],
    );
    const existing = existingRows[0] ? mapRow(existingRows[0]) : null;
    if (!existing) {
      throw new InternalServerErrorException('Settings handoff race produced no row');
    }
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw new ConflictException(
        'Idempotency-Key was already used with a different request payload.',
      );
    }
    return existing;
  }

  async markOdooCommitted(id: string, finalResponse: unknown): Promise<void> {
    await controlDataSource.query(
      `UPDATE "company_mutation_handoff"
       SET "state" = 'odoo_committed', "final_response" = $2, "updated_at" = now()
       WHERE "id" = $1`,
      [id, JSON.stringify(finalResponse ?? null)],
    );
  }

  async markAudited(id: string): Promise<void> {
    await controlDataSource.query(
      `UPDATE "company_mutation_handoff"
       SET "state" = 'audited', "updated_at" = now(), "lease_owner" = NULL, "lease_expires_at" = NULL
       WHERE "id" = $1`,
      [id],
    );
  }

  /**
   * Releases a handoff that never reached Odoo (a typed validation error, e.g.
   * `KEMFAI_SETUP_INCOMPLETE`) — nothing committed there, so nothing needs recovery, and
   * a completion handoff must not permanently occupy the tenant's single slot when the
   * wizard genuinely was not complete yet.
   */
  async deletePending(id: string): Promise<void> {
    await controlDataSource.query(
      `DELETE FROM "company_mutation_handoff" WHERE "id" = $1 AND "state" = 'pending'`,
      [id],
    );
  }

  /**
   * Lease-based claim for `CompanyMutationRecoveryWorker` (arbiter resolution point 4):
   * `FOR UPDATE SKIP LOCKED` lets concurrent worker ticks/instances claim disjoint
   * batches safely. Only rows whose lease has actually expired (or was never claimed),
   * whose state is still non-terminal, and whose backoff window has elapsed are
   * eligible — a handoff already `audited` is never reclaimed.
   */
  async claimBatchForRecovery(
    leaseOwner: string,
    leaseDurationMs: number,
    batchSize: number,
  ): Promise<CompanyMutationHandoffRow[]> {
    const result = await controlDataSource.query(
      `WITH "claimable" AS (
         SELECT "id" FROM "company_mutation_handoff"
         WHERE "state" IN ('pending', 'odoo_committed')
           AND ("lease_expires_at" IS NULL OR "lease_expires_at" < now())
           AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= now())
         ORDER BY "created_at" ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       UPDATE "company_mutation_handoff" h
       SET "lease_owner" = $1,
           "lease_expires_at" = now() + ($2 * interval '1 millisecond'),
           "retry_count" = h."retry_count" + 1,
           "updated_at" = now()
       FROM "claimable" c
       WHERE h."id" = c."id"
       RETURNING h.*`,
      [leaseOwner, leaseDurationMs, batchSize],
    );
    // TypeORM's raw-query driver returns a bare rows array for INSERT/SELECT ...
    // RETURNING, but a [rows, affectedRowCount] tuple for UPDATE/DELETE ... RETURNING
    // (verified against real Postgres — every row here is a plain object, so a
    // genuine row can never itself satisfy Array.isArray, making this a safe,
    // unambiguous way to unwrap either shape).
    const rows = Array.isArray(result[0]) ? result[0] : result;
    return rows.map(mapRow);
  }

  /**
   * Bounded backoff on a worker-side failure (e.g. Odoo or the audit store is still
   * down): releases the lease and schedules a later retry rather than hot-looping
   * against a resource that just failed.
   */
  async scheduleRetryBackoff(id: string, delayMs: number): Promise<void> {
    await controlDataSource.query(
      `UPDATE "company_mutation_handoff"
       SET "lease_owner" = NULL, "lease_expires_at" = NULL,
           "next_attempt_at" = now() + ($2 * interval '1 millisecond'),
           "updated_at" = now()
       WHERE "id" = $1`,
      [id, delayMs],
    );
  }
}
