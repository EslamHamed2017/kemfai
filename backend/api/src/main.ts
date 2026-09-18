import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupOpenApi } from './openapi/openapi-contract';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Graceful BullMQ shutdown (queue/worker connections close on SIGTERM/SIGINT),
  // required by @nestjs/bullmq's lifecycle hooks now that QueuesModule (T021) is wired.
  app.enableShutdownHooks();
  // T022: serve the committed contracts/openapi.yaml verbatim — swagger-ui at /api-docs,
  // the byte-exact contract JSON at /api-docs-json (zero-drift source of truth for the
  // contract-test suites).
  setupOpenApi(app);
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}

bootstrap();
