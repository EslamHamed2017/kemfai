import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ALL_QUEUE_NAMES } from './queue-names';
import { redisConnectionFromUrl } from './redis-connection';
import { QueueSchedulingService } from './queue-scheduling.service';

/**
 * T021: the single BullMQ wiring point for the BFF. Registers the shared Redis
 * connection (REDIS_URL), declares the five queues from contracts/events.md exactly
 * once, and re-exports BullModule so feature modules importing QueuesModule can inject
 * any registered queue via @InjectQueue(name) without re-declaring connection details.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({ connection: redisConnectionFromUrl() }),
    }),
    BullModule.registerQueue(...ALL_QUEUE_NAMES.map((name) => ({ name }))),
  ],
  providers: [QueueSchedulingService],
  exports: [BullModule],
})
export class QueuesModule {}
