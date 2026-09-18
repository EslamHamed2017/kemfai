import {
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { AuditService } from '../../modules/audit/audit.service';
import { TenantScopedRequest } from '../tenant-context/tenant-context.model';

export const AUDIT_EVENT_KEY = 'kemfai:auditEvent';

/**
 * Given the injected AuditService, the request (already carrying `req.auth` /
 * `req.tenantContext`, populated by the global guard chain), and the handler's return
 * value, emits exactly one of AuditService's catalog `record*` methods. Resolvers pick the
 * method and shape its input — they never construct an action string themselves, keeping
 * `audit.service.ts` the single source of truth for the FR-007 catalog (T019).
 */
export type AuditEventResolver = (
  audit: AuditService,
  req: TenantScopedRequest,
  result: unknown,
) => Promise<void> | void;

/** Declares the audit emission a successful response from this handler must produce. */
export const Audited = (resolver: AuditEventResolver): MethodDecorator =>
  SetMetadata(AUDIT_EVENT_KEY, resolver);

/**
 * Runs an `@Audited()` resolver after — never before — a handler produces its response, so
 * an action that ultimately throws is never recorded as having happened. The resolver is
 * awaited inside the RxJS pipeline via `switchMap`/`from` (not `tap`'s synchronous callback,
 * which would let a thrown async error escape as an unhandled rejection instead of failing
 * the response): a resolver failure is not swallowed, it replaces the response with 500, so
 * the platform never serves a successful response for an action whose mandatory audit
 * record failed to persist (same fail-closed contract TenantScopeGuard applies to denial
 * audits, T017). Routes without `@Audited()` pass through unchanged.
 */
@Injectable()
export class AuditEventInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const resolver = this.reflector.get<AuditEventResolver | undefined>(
      AUDIT_EVENT_KEY,
      context.getHandler(),
    );
    if (!resolver) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<TenantScopedRequest>();

    return next.handle().pipe(
      switchMap((result) =>
        from(
          (async () => {
            try {
              await resolver(this.audit, req, result);
            } catch {
              throw new InternalServerErrorException(
                'Action succeeded but its mandatory audit record could not be written',
              );
            }
            return result;
          })(),
        ),
      ),
    );
  }
}
