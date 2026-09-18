import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Graceful BullMQ shutdown (queue/worker connections close on SIGTERM/SIGINT),
  // required by @nestjs/bullmq's lifecycle hooks now that QueuesModule (T021) is wired.
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}

bootstrap();
