import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { INTERNAL_ROLES } from '../decorators/roles.decorator';
import { AuditService } from '../../modules/audit/audit.service';
import { AuditActorType } from '../../modules/audit/entities/audit-event.entity';
import {
  AttemptedTenantReference,
  TenantScopedRequest,
} from '../tenant-context/tenant-context.model';
import { collectTenantReferences } from '../tenant-context/collect-tenant-references';
import { TenantContextResolver } from '../tenant-context/tenant-context.resolver';
import { TenantOwnershipRegistry } from '../tenant-context/tenant-ownership.registry';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * Global cross-tenant access denial (T017, FR-001, SC-004). Registered once via APP_GUARD
 * in AppModule — never per-endpoint — directly after the (equally global) BearerAuthGuard
 * so `req.auth` is guaranteed populated when this guard runs.
 *
 * A request bearing Tenant A's identity attempting to reach any Tenant B resource —
 * whether via an explicit tenantId in path/query/body/header or via an ordinary resource
 * ID on a route declared with @TenantOwnedResource — is denied with 403 and a
 * `tenant_access.denied_cross_tenant` audit event is AWAITED before this guard exits.
 * If the audit write itself fails, the guard fails closed with 500: an unaudited denial
 * is never served as 403 (T017 acceptance criterion; events.md catalog).
 *
 * References the guard cannot attribute to an existing row (unknown or malformed ids)
 * are passed through so the handler answers 404 — a denial would leak existence.
 */
@Injectable()
export class TenantScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContextResolver: TenantContextResolver,
    private readonly ownershipRegistry: TenantOwnershipRegistry,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controllerClass = context.getClass();

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controllerClass])) {
      return true;
    }

    const req = context.switchToHttp().getRequest<TenantScopedRequest>();
    // Authentication is BearerAuthGuard's concern (it runs first, globally). Reaching
    // this point without req.auth can only mean the route left authentication to a
    // later-scoped guard, which rejects unauthenticated callers itself.
    if (!req.auth) {
      return true;
    }

    // Internal-realm identities are not customer-tenant-scoped (data-model.md "Cross-cutting:
    // Roles & Scopes"): BillingAdmin/SuperAdmin/CustomerSuccess/TechnicalAdmin are cross-tenant
    // by design, and Support's narrower per-tenant grant scope is RoleGuard's job (T018), not
    // this guard's customer-isolation check (FR-001). Trusting the JWT's roles claim here is
    // safe because BearerAuthGuard only accepts it after verifying the token's signature, and
    // realm separation means a kemfai-customers Account can never hold one of these roles (FR-004).
    const callerRoles = req.auth.roles ?? [];
    if (callerRoles.some((role) => (INTERNAL_ROLES as readonly string[]).includes(role))) {
      return true;
    }

    const tenantContext = await this.tenantContextResolver.resolveForRequest(req);

    const references: AttemptedTenantReference[] = await collectTenantReferences(
      this.reflector,
      this.ownershipRegistry,
      context,
      req,
    );

    const violation = references.find(
      (ref) => ref.owningTenantId !== null && ref.owningTenantId !== tenantContext.callerTenantId,
    );

    if (!violation) {
      return true;
    }

    await this.recordDenialOrFailClosed(req, tenantContext, violation);
    throw new ForbiddenException('Request denied: tenant scope violation');
  }

  /**
   * Writes the tenant_access.denied_cross_tenant event and only then lets the caller
   * throw the 403. The audit write is awaited and never swallowed: on failure the guard
   * fails closed with 500 — serving the 403 without the audit row would violate the
   * T017 acceptance criterion ("writes the audit event before the guard exits", events.md
   * catalog). Per events.md, tenant_id is the REQUESTING tenant (the caller's), not the
   * target, and the payload carries the target tenant plus the attempted resource path.
   */
  private async recordDenialOrFailClosed(
    req: TenantScopedRequest,
    tenantContext: { accountId: string | null; callerTenantId: string | null },
    violation: AttemptedTenantReference,
  ): Promise<void> {
    const event = {
      // Only customer-realm accounts can pass BearerAuthGuard today; internal-user denials
      // would carry AuditActorType.INTERNAL_USER once the internal realm is wired in.
      actorType: AuditActorType.ACCOUNT,
      actorId: tenantContext.accountId,
      tenantId: tenantContext.callerTenantId,
      action: 'tenant_access.denied_cross_tenant',
      subjectType: violation.resourceType,
      subjectId: pickSubjectId(violation, tenantContext.accountId),
      occurredAt: new Date(),
      payload: {
        target_tenant_id: violation.owningTenantId,
        resource_path: `${req.method} ${req.originalUrl ?? req.url}`,
        attempted_id: violation.attemptedId,
        reference_source: violation.source,
      },
    };
    try {
      await this.audit.append(event);
    } catch {
      throw new InternalServerErrorException(
        'Tenant access was denied but the mandatory audit record could not be written',
      );
    }
  }
}

function pickSubjectId(violation: AttemptedTenantReference, accountId: string | null): string {
  if (violation.attemptedId && UUID_PATTERN.test(violation.attemptedId)) {
    return violation.attemptedId;
  }
  if (violation.owningTenantId && UUID_PATTERN.test(violation.owningTenantId)) {
    return violation.owningTenantId;
  }
  if (accountId && UUID_PATTERN.test(accountId)) {
    return accountId;
  }
  // audit_event.subject_id is a NOT NULL uuid column; a denial provoked by a non-UUID
  // reference (which cannot name any real resource) still records the attempt.
  return NIL_UUID;
}
