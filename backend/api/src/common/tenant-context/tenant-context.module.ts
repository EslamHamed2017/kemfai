import { Module } from '@nestjs/common';
import { TenantContextResolver } from './tenant-context.resolver';
import { TenantOwnershipRegistry } from './tenant-ownership.registry';

/**
 * Request-scoped tenant identity + resource-ownership resolution for the global
 * TenantScopeGuard (T017). Kept free of HTTP concerns: the guard itself lives in
 * common/guards/tenant-scope.guard.ts and is registered once, globally, in AppModule.
 */
@Module({
  providers: [TenantContextResolver, TenantOwnershipRegistry],
  exports: [TenantContextResolver, TenantOwnershipRegistry],
})
export class TenantContextModule {}
