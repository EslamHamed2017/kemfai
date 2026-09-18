import { Module } from '@nestjs/common';
import { IdempotencyKeyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';

@Module({
  providers: [IdempotencyService, IdempotencyKeyInterceptor],
  exports: [IdempotencyService, IdempotencyKeyInterceptor],
})
export class IdempotencyModule {}
