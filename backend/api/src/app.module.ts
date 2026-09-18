import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './modules/audit/audit.module';
import { EntitlementsModule } from './modules/entitlements/entitlements.module';
import { TenantContextModule } from './common/tenant-context/tenant-context.module';
import { BearerAuthGuard } from './common/guards/bearer-auth.guard';
import { TenantScopeGuard } from './common/guards/tenant-scope.guard';
import { RoleGuard } from './common/guards/role.guard';

@Module({
  imports: [AuditModule, TenantContextModule, EntitlementsModule],
  controllers: [AppController],
  providers: [
    AppService,
    // Global guard chain: authentication (T017), then tenant scoping (T017), then role
    // enforcement (T018) — all APP_GUARD so no route can forget them (registration order =
    // execution order). Public surfaces opt out explicitly via @Public().
    { provide: APP_GUARD, useClass: BearerAuthGuard },
    { provide: APP_GUARD, useClass: TenantScopeGuard },
    { provide: APP_GUARD, useClass: RoleGuard },
  ],
})
export class AppModule {}
