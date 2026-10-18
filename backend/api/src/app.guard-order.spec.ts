import 'reflect-metadata';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from './app.module';
import { FeatureFlagGuard } from './common/guards/feature-flag.guard';
import { RoleGuard } from './common/guards/role.guard';
import { SupportAccessGuard } from './common/guards/support-access.guard';

describe('AppModule support-access guard ordering', () => {
  it('hides flagged routes before support audit and audits grant denials before role rejection', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as Array<{
      provide?: string | symbol;
      useClass?: unknown;
    }>;
    const guards = providers
      .filter((provider) => provider.provide === APP_GUARD)
      .map((provider) => provider.useClass);
    expect(guards.indexOf(FeatureFlagGuard)).toBeLessThan(guards.indexOf(SupportAccessGuard));
    expect(guards.indexOf(SupportAccessGuard)).toBeLessThan(guards.indexOf(RoleGuard));
  });
});
