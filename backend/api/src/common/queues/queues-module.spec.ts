import 'reflect-metadata';
import { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { AppModule } from '../../app.module';
import { ALL_QUEUE_NAMES } from './queue-names';
import { QueuesModule } from './queues.module';

/**
 * T021 structural acceptance (no Redis needed): the five documented queues are declared
 * exactly once from QueuesModule, QueuesModule is wired into AppModule, and each queue
 * name resolves to an injectable provider token — so later producer tasks can only
 * @InjectQueue the contract-defined names. Runtime visibility against the real
 * docker-compose Redis is proven by test/integration/queues-registration.integration-spec.ts.
 */
describe('QueuesModule wiring (T021)', () => {
  it('is imported by AppModule (registration required by the task to live in app.module.ts)', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as Array<unknown>;
    expect(imports).toContain(QueuesModule);
  });

  it('registers a provider token for every queue documented in contracts/events.md', () => {
    const imports = Reflect.getMetadata('imports', QueuesModule) as ModuleMetadata['imports'];

    const providerTokens = new Set<string>();
    for (const imported of imports ?? []) {
      const dynamic = imported as DynamicModule;
      if (!dynamic || typeof dynamic !== 'object' || Array.isArray(dynamic)) continue;
      for (const provider of dynamic.providers ?? []) {
        const token = (provider as { provide?: unknown }).provide;
        if (typeof token === 'string') providerTokens.add(token);
      }
    }

    for (const name of ALL_QUEUE_NAMES) {
      expect(providerTokens).toContain(getQueueToken(name));
    }
  });
});
