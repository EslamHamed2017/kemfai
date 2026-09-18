import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
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
 *
 * Unlike the auth guards, this guard does NOT exempt `@Public()` routes: publicness is an
 * authentication concern, while module completeness applies to the surface itself. An
 * incomplete-but-public surface (e.g. signup before its user story is finished — T032 review
 * finding, 2026-09-19) must stay hidden behind its flag exactly like an authenticated one,
 * or the constitution's gating rule would be unenforceable for every pre-auth workflow.
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
