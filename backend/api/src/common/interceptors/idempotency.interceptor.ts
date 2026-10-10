import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Observable, firstValueFrom, from, throwError } from 'rxjs';
import { IdempotencyRecordStatus } from '../../modules/idempotency/entities/idempotency-key.entity';
import { IdempotencyService } from '../../modules/idempotency/idempotency.service';
import { TenantScopedRequest } from '../tenant-context/tenant-context.model';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const IDEMPOTENCY_HEADER = 'idempotency-key';
const LEASE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fingerprintOf(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? {}))
    .digest('hex');
}

/**
 * Replay scope = the server-verified caller identity from BearerAuthGuard's `req.auth`,
 * plus the request-resolved tenant (`callerTenantId`, populated by TenantScopeGuard's
 * resolver before interceptors run) so one account's stored responses are never reachable
 * from another tenant context — scope isolation mirrors tenant isolation (review-driven
 * fix: an earlier draft omitted `callerTenantId` from the scope).
 *
 * Returns null for unauthenticated requests. There deliberately is NO anonymous scope:
 * pre-authentication the server has no verifiable identity to bind a claim to, and every
 * substitute signal was rejected in review — a global "anonymous" scope (or a client IP,
 * shared by everyone behind one NAT/proxy) lets one caller receive another caller's stored
 * response when key+route collide, a cross-caller data leak. So unauthenticated requests
 * are never given idempotency semantics: they always execute normally and nothing is
 * stored or replayed for them (mirroring the standard contract, e.g. Stripe, where
 * idempotency keys are meaningful only for authenticated principals).
 */
export function scopeOf(req: TenantScopedRequest): string | null {
  const sub = req.auth?.keycloakUserId;
  if (!sub) {
    return null;
  }
  const callerTenantId = req.tenantContext?.callerTenantId;
  return callerTenantId ? `keycloak:${sub}:tenant:${callerTenantId}` : `keycloak:${sub}`;
}

/**
 * Guards mutating endpoints against re-executing side effects when a client retries a
 * request carrying the same `Idempotency-Key` header (T020, Constitution Principle VII).
 * Registered globally (`APP_INTERCEPTOR` in AppModule) so it covers every current and
 * future mutating route without each one needing to opt in — a route is only affected when
 * an authenticated caller actually sends the header (see `scopeOf`: unauthenticated
 * requests are always passed through and never stored or replayed).
 *
 * Sequencing is the load-bearing part of this design: a `pending` claim row is inserted and
 * committed BEFORE the handler runs (never after), so a persisted claim always predates the
 * side effect it guards. The claim only flips to `completed` after the handler resolves.
 * Two concurrent requests for the same key can never both execute the handler: only one can
 * win the claim's `INSERT ... ON CONFLICT DO NOTHING`; the loser polls the winner's row
 * until it completes and replays its stored response. No connection or transaction is held
 * open across the handler's own execution — `IdempotencyService` issues only short,
 * independent queries before and after — so this cannot deadlock the pool the handler's own
 * queries need (a held-transaction design was the previously rejected draft).
 *
 * If a claimant crashes between claiming and completing, a later retry reclaims the row
 * once its lease (`LEASE_TIMEOUT_MS`) expires, via a compare-and-swap `UPDATE` so only one
 * reclaimer wins. This bounds an inherent limitation of any two-phase idempotency design
 * that cannot span a single distributed transaction across this table and the handler's
 * arbitrary side effects: a crash in that exact window can cause at most one re-execution,
 * never an unbounded number.
 */
@Injectable()
export class IdempotencyKeyInterceptor implements NestInterceptor {
  constructor(private readonly idempotency: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<TenantScopedRequest>();
    const header = req.headers[IDEMPOTENCY_HEADER];
    const idempotencyKey = Array.isArray(header) ? header[0] : header;

    const scope = scopeOf(req);
    if (!MUTATING_METHODS.has(req.method) || !idempotencyKey || !scope) {
      return next.handle();
    }
    const contentTypeHeader = req.headers['content-type'];
    const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
    if (contentType?.toLowerCase().startsWith('multipart/form-data')) {
      // Global interceptors run before route-scoped FileInterceptor, so req.body/file are
      // not available here. Hashing `{}` would let a reused key replay a response for a
      // different proof/reference. Fail closed rather than claim or replay an unsafe slot;
      // payment-submission duplicate safety still comes from its DB period constraint.
      return throwError(
        () =>
          new ConflictException(
            'Idempotency-Key cannot be used with multipart requests because the payload cannot be safely fingerprinted.',
          ),
      );
    }
    const path = req.path;
    const fingerprint = fingerprintOf(req.body);

    return from(this.resolve(scope, idempotencyKey, req.method, path, fingerprint, next));
  }

  private async resolve(
    scope: string,
    idempotencyKey: string,
    method: string,
    path: string,
    fingerprint: string,
    next: CallHandler,
  ): Promise<unknown> {
    const claimedId = await this.idempotency.claim({
      scope,
      idempotencyKey,
      method,
      path,
      fingerprint,
    });
    if (claimedId) {
      return this.runAndSettle(claimedId, next);
    }

    return this.awaitExistingClaim(scope, idempotencyKey, method, path, fingerprint, next);
  }

  private async runAndSettle(id: string, next: CallHandler): Promise<unknown> {
    let result: unknown;
    try {
      result = await firstValueFrom(next.handle());
    } catch (err) {
      await this.idempotency.release(id);
      throw err;
    }
    await this.idempotency.complete(id, result);
    return result;
  }

  private async awaitExistingClaim(
    scope: string,
    idempotencyKey: string,
    method: string,
    path: string,
    fingerprint: string,
    next: CallHandler,
    deadline = Date.now() + POLL_TIMEOUT_MS,
  ): Promise<unknown> {
    const existing = await this.idempotency.find(scope, idempotencyKey, method, path);
    if (!existing) {
      // The prior holder released its claim (its handler failed) between our failed claim
      // attempt and this read. Nothing to replay or wait for — try to claim it ourselves.
      const claimedId = await this.idempotency.claim({
        scope,
        idempotencyKey,
        method,
        path,
        fingerprint,
      });
      if (claimedId) {
        return this.runAndSettle(claimedId, next);
      }
      return this.awaitExistingClaim(
        scope,
        idempotencyKey,
        method,
        path,
        fingerprint,
        next,
        deadline,
      );
    }

    if (existing.fingerprint !== fingerprint) {
      throw new ConflictException(
        'Idempotency-Key was already used with a different request payload.',
      );
    }

    if (existing.status === IdempotencyRecordStatus.COMPLETED) {
      return existing.responseBody;
    }

    const isStale = Date.now() - existing.lockedAt.getTime() > LEASE_TIMEOUT_MS;
    if (isStale) {
      const reclaimed = await this.idempotency.reclaimStale(existing.id, existing.lockedAt);
      if (reclaimed) {
        return this.runAndSettle(existing.id, next);
      }
      // Someone else reclaimed it first; fall through and poll their result instead.
    }

    if (Date.now() >= deadline) {
      throw new ConflictException('Request with this Idempotency-Key is still being processed.');
    }

    await sleep(POLL_INTERVAL_MS);
    return this.awaitExistingClaim(
      scope,
      idempotencyKey,
      method,
      path,
      fingerprint,
      next,
      deadline,
    );
  }
}
