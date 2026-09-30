import { Module } from '@nestjs/common';
import { QueuesModule } from '../../common/queues/queues.module';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [QueuesModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
