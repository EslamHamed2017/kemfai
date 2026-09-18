import { Injectable } from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { IdempotencyRecordStatus } from './entities/idempotency-key.entity';

export interface IdempotencyClaimRequest {
  scope: string;
  idempotencyKey: string;
  method: string;
  path: string;
  fingerprint: string;
}

export interface IdempotencyRecordRow {
  id: string;
  fingerprint: string;
  status: IdempotencyRecordStatus;
  responseBody: unknown;
  lockedAt: Date;
}

/**
 * Raw-SQL data access for the `idempotency_key` table (T020). Every method here issues a
 * single independent statement against `controlDataSource`'s connection pool — none opens
 * an explicit transaction or holds a checked-out client across an `await` boundary — so a
 * mutating handler running between `claim()` and `complete()`/`release()` always has the
 * full pool available to it. This is deliberate: an earlier draft held a transaction open
 * for the handler's entire execution and could deadlock the pool under saturation.
 */
@Injectable()
export class IdempotencyService {
  /**
   * Attempts to atomically claim the (scope, key, method, path) slot. Returns the new
   * row's id on success. Returns null when a row already exists for this slot — the
   * caller must then inspect it via `find()` to decide between replay, conflict, or
   * waiting on an in-flight claim.
   */
  async claim(input: IdempotencyClaimRequest): Promise<string | null> {
    const rows = await controlDataSource.query(
      `INSERT INTO "idempotency_key"
         ("scope", "idempotency_key", "method", "path", "fingerprint", "status", "locked_at")
       VALUES ($1, $2, $3, $4, $5, 'pending', now())
       ON CONFLICT ("scope", "idempotency_key", "method", "path") DO NOTHING
       RETURNING "id"`,
      [input.scope, input.idempotencyKey, input.method, input.path, input.fingerprint],
    );
    return (rows[0]?.id as string | undefined) ?? null;
  }

  async find(
    scope: string,
    idempotencyKey: string,
    method: string,
    path: string,
  ): Promise<IdempotencyRecordRow | null> {
    const rows = await controlDataSource.query(
      `SELECT "id", "fingerprint", "status", "response_body", "locked_at"
       FROM "idempotency_key"
       WHERE "scope" = $1 AND "idempotency_key" = $2 AND "method" = $3 AND "path" = $4`,
      [scope, idempotencyKey, method, path],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id as string,
      fingerprint: row.fingerprint as string,
      status: row.status as IdempotencyRecordStatus,
      responseBody: row.response_body,
      lockedAt: new Date(row.locked_at as string),
    };
  }

  /**
   * Compare-and-swap reclaim of a `pending` row whose lease has expired (the claimant most
   * likely crashed before completing or releasing it). Passing the exact `lockedAt`
   * previously read guards against two stale-reclaim attempts both succeeding — only one
   * `UPDATE` can match the still-unchanged `locked_at` value.
   */
  async reclaimStale(id: string, previousLockedAt: Date): Promise<boolean> {
    const rows = await controlDataSource.query(
      `UPDATE "idempotency_key"
       SET "locked_at" = now()
       WHERE "id" = $1 AND "status" = 'pending' AND "locked_at" = $2
       RETURNING "id"`,
      [id, previousLockedAt.toISOString()],
    );
    return rows.length === 1;
  }

  async complete(id: string, responseBody: unknown): Promise<void> {
    await controlDataSource.query(
      `UPDATE "idempotency_key"
       SET "status" = 'completed', "response_body" = $2, "completed_at" = now()
       WHERE "id" = $1`,
      [id, JSON.stringify(responseBody ?? null)],
    );
  }

  /** Releases a claim whose handler failed, so a genuine retry is not blocked forever. */
  async release(id: string): Promise<void> {
    await controlDataSource.query(
      `DELETE FROM "idempotency_key" WHERE "id" = $1 AND "status" = 'pending'`,
      [id],
    );
  }
}
