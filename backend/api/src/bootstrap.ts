import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import controlDataSource from './database/data-source';
import { setupOpenApi } from './openapi/openapi-contract';

export async function bootstrap() {
  if (!controlDataSource.isInitialized) {
    await controlDataSource.initialize();
  }

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  setupOpenApi(app);
  await app.listen(process.env.PORT ?? 3000);
  return app;
}
