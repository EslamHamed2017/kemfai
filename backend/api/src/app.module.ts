import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './modules/audit/audit.module';
import { EntitlementsModule } from './modules/entitlements/entitlements.module';
import { IdempotencyModule } from './modules/idempotency/idempotency.module';
import { PlansModule } from './modules/plans/plans.module';
import { TenantContextModule } from './common/tenant-context/tenant-context.module';
import { BearerAuthGuard } from './common/guards/bearer-auth.guard';
import { TenantScopeGuard } from './common/guards/tenant-scope.guard';
import { RoleGuard } from './common/guards/role.guard';
import { FeatureFlagGuard } from './common/guards/feature-flag.guard';
import { TrialWindowGuard } from './common/guards/trial-window.guard';
import { IdempotencyKeyInterceptor } from './common/interceptors/idempotency.interceptor';
import { QueuesModule } from './common/queues/queues.module';
import { TrialExpirySweepModule } from './integrations/provisioning/trial-expiry-sweep.module';

@Module({
  imports: [
    AuditModule,
    TenantContextModule,
    EntitlementsModule,
    IdempotencyModule,
    PlansModule,
    QueuesModule,
    TrialExpirySweepModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global guard chain: authentication (T017), then tenant scoping (T017), then role
    // enforcement (T018), then module-completeness gating (T100), then trial-window
    // enforcement (T101) — all APP_GUARD so no route can forget them (registration order =
    // execution order). Public surfaces opt out explicitly via @Public(); FeatureFlagGuard only
    // acts on handlers declaring @RequireFeatureFlag(); TrialWindowGuard only acts on handlers
    // declaring @EnforceTrialWindow().
    { provide: APP_GUARD, useClass: BearerAuthGuard },
    { provide: APP_GUARD, useClass: TenantScopeGuard },
    { provide: APP_GUARD, useClass: RoleGuard },
    { provide: APP_GUARD, useClass: FeatureFlagGuard },
    { provide: APP_GUARD, useClass: TrialWindowGuard },
    // Global idempotency-key replay guard (T020) — applies to every mutating route, current
    // and future, without each one opting in; it only activates when a caller actually
    // sends an Idempotency-Key header.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyKeyInterceptor },
  ],
})
export class AppModule {}
