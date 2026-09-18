import { SetMetadata } from '@nestjs/common';

export const FEATURE_FLAG_KEY = 'kemfai:requiredFeatureFlag';

/**
 * Declares the `FeatureFlag.feature_key` (data-model.md) that must be enabled for a handler (or
 * whole controller) to be reachable. Enforced once, globally, by `FeatureFlagGuard` (T100) — a
 * module not yet complete stays hidden platform-wide until its flag is explicitly turned on
 * (Constitution Principle VI), independent of any plan's `PlanFeatureEntitlement`. Handlers with
 * no `@RequireFeatureFlag()` are not gated by this guard.
 */
export const RequireFeatureFlag = (featureKey: string): MethodDecorator & ClassDecorator =>
  SetMetadata(FEATURE_FLAG_KEY, featureKey);
