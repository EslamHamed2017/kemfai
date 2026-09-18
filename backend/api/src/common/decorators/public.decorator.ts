import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'kemfai:isPublicRoute';

/**
 * Marks a handler (or whole controller) as excluded from the global guard chain
 * (BearerAuthGuard + TenantScopeGuard). Required for the genuinely public surfaces of the
 * BFF (e.g. `GET /public/plans`, signup, health) now that authentication is applied
 * globally so that TenantScopeGuard can rely on `req.auth` being populated when it runs
 * (global guards run before controller/route-scoped guards, so a per-route
 * `@UseGuards(BearerAuthGuard)` would execute too late for TenantScopeGuard to see).
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
