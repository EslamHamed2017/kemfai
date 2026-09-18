import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { FEATURE_FLAG_KEY } from '../decorators/feature-flag.decorator';
import { EntitlementsService } from '../../modules/entitlements/entitlements.service';

/**
 * Global module-completeness gate (T100, Constitution Principle VI, C1 remediation —
 * analysis.md). Registered once via APP_GUARD in AppModule — never per-endpoint — so a single
 * implementation hides an incomplete module's customer-facing surface identically for
 * UI-driven and raw HTTP calls (same FR-006 pattern as RoleGuard/TenantScopeGuard).
 *
 * A handler with no `@RequireFeatureFlag()` is unaffected. When a flag is declared,
 * `FeatureFlag.enabled=false` (data-model.md: "hides the corresponding customer-facing surface
 * entirely, not merely disables an action") is enforced by answering 404 rather than 403 — the
 * gated surface must not even reveal its existence to a caller who lacks the flag, mirroring
 * TenantScopeGuard's "denial would leak existence" rule for unresolvable references. This is
 * independent of PlanFeatureEntitlement/PlanSetting/EntitlementDefault (T010): a feature can be
 * fully entitled by plan and still hidden while incomplete.
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controllerClass = context.getClass();

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controllerClass])) {
      return true;
    }

    const featureKey = this.reflector.getAllAndOverride<string>(FEATURE_FLAG_KEY, [
      handler,
      controllerClass,
    ]);
    if (!featureKey) {
      return true;
    }

    const enabled = await this.entitlements.isFeatureFlagEnabled(featureKey);
    if (!enabled) {
      throw new NotFoundException('This feature is not available');
    }

    return true;
  }
}
