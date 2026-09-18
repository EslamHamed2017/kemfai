import { SetMetadata } from '@nestjs/common';

export const TRIAL_WINDOW_KEY = 'kemfai:enforceTrialWindow';

/**
 * Marks a handler (or whole controller) as one of the FR-030a onboarding-scoped surfaces
 * (company setup, module selection, checklist) that `TrialWindowGuard` (T101) must restrict once
 * a tenant's trial window has elapsed with auto-restriction enabled and no `Active` Subscription.
 * Handlers with no `@EnforceTrialWindow()` are unaffected by this guard.
 */
export const EnforceTrialWindow = (): MethodDecorator & ClassDecorator =>
  SetMetadata(TRIAL_WINDOW_KEY, true);
