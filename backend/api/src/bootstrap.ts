import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import controlDataSource from './database/data-source';
import { setupOpenApi } from './openapi/openapi-contract';

export function configuredTrustProxyHops(): number | null {
  const raw = process.env.KEMFAI_TRUST_PROXY_HOPS?.trim();
  if (!raw) return null;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error('KEMFAI_TRUST_PROXY_HOPS must be an integer between 1 and 5');
  }
  const hops = Number(raw);
  if (!Number.isSafeInteger(hops) || hops > 5) {
    throw new Error('KEMFAI_TRUST_PROXY_HOPS must be an integer between 1 and 5');
  }
  return hops;
}

export async function bootstrap() {
  if (!controlDataSource.isInitialized) {
    await controlDataSource.initialize();
  }

  const app = await NestFactory.create(AppModule);
  const trustProxyHops = configuredTrustProxyHops();
  if (trustProxyHops !== null) {
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxyHops);
  }
  app.enableShutdownHooks();
  setupOpenApi(app);
  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '0.0.0.0');
  return app;
}
