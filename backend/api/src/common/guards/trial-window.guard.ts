import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { TRIAL_WINDOW_KEY } from '../decorators/trial-window.decorator';
import { TenantScopedRequest } from '../tenant-context/tenant-context.model';
import { TenantContextResolver } from '../tenant-context/tenant-context.resolver';
import { EntitlementsService } from '../../modules/entitlements/entitlements.service';
import controlDataSource from '../../database/data-source';
import { Tenant } from '../../modules/tenants/entities/tenant.entity';
import {
  Subscription,
  SubscriptionStatus,
} from '../../modules/billing-customer/entities/subscription.entity';
import { AuditService } from '../../modules/audit/audit.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Enforces FR-030a's trial window on the onboarding-scoped surfaces that declare
 * `@EnforceTrialWindow()` (company setup T054, module selection T076, checklist T082). Registered
 * once via APP_GUARD in AppModule, after RoleGuard/FeatureFlagGuard — never per-endpoint — so
 * enforcement is identical for UI-driven and raw HTTP paths (F2 remediation, analysis.md).
 *
 * Every value that decides the outcome (`trialWindowDays`, `autoRestrictUnpaid`) is read
 * exclusively through `EntitlementsService` (T010/T099's single-source-of-truth rule) — never
 * hard-coded or read from `PlanSetting`/`EntitlementDefault` directly. An `Active` Subscription
 * always bypasses the guard regardless of elapsed time; a resolved `autoRestrictUnpaid=false`
 * never restricts.
 */
@Injectable()
export class TrialWindowGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContextResolver: TenantContextResolver,
    private readonly entitlements: EntitlementsService,
    private readonly auditService: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controllerClass = context.getClass();

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controllerClass])) {
      return true;
    }

    const enforced = this.reflector.getAllAndOverride<boolean>(TRIAL_WINDOW_KEY, [
      handler,
      controllerClass,
    ]);
    if (!enforced) {
      return true;
    }

    const req = context.switchToHttp().getRequest<TenantScopedRequest>();
    // Authentication is BearerAuthGuard's concern (it runs first, globally). Reaching this
    // point without req.auth can only mean the route left authentication to a later-scoped
    // guard, which rejects unauthenticated callers itself.
    if (!req.auth) {
      return true;
    }

    const tenantContext = await this.tenantContextResolver.resolveForRequest(req);
    if (!tenantContext.callerTenantId) {
      return true;
    }

    const subscriptionRepo = controlDataSource.getRepository(Subscription);
    const subscription = await subscriptionRepo.findOne({
      where: { tenantId: tenantContext.callerTenantId },
    });
    if (subscription?.status === SubscriptionStatus.ACTIVE) {
      return true;
    }

    const tenantRepo = controlDataSource.getRepository(Tenant);
    const tenant = await tenantRepo.findOne({ where: { id: tenantContext.callerTenantId } });
    // A tenant that never finished provisioning (no ready_at) or has no Subscription row yet
    // has not started its trial clock — nothing for this guard to restrict (T044 always creates
    // the Subscription row before marking Tenant Ready, so this is a pass-through, not a gap).
    if (!tenant?.readyAt || !subscription) {
      return true;
    }

    const entitlementSet = await this.entitlements.getEntitlementSet(subscription.planId);
    if (!entitlementSet.autoRestrictUnpaid) {
      return true;
    }

    const elapsedMs = Date.now() - tenant.readyAt.getTime();
    const windowMs = entitlementSet.trialWindowDays * MS_PER_DAY;
    if (elapsedMs <= windowMs) {
      return true;
    }

    // contracts/events.md defines this as the tenant's first-crossing event, emitted by
    // either the live guard or the sweep. AuditService's tenant-stable dedupe key makes
    // both producers converge through PostgreSQL even when they race.
    await this.auditService.recordTenantTrialRestricted({
      tenantId: tenant.id,
      trialWindowDays: entitlementSet.trialWindowDays,
      elapsedDays: Math.floor(elapsedMs / MS_PER_DAY),
      autoRestrictUnpaid: entitlementSet.autoRestrictUnpaid,
    });

    throw new ForbiddenException('Trial window has ended; activate a subscription to continue');
  }
}
