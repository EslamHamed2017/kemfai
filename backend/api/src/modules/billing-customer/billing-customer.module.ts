import { Module } from '@nestjs/common';
import { BillingCustomerController } from './billing-customer.controller';
import { BillingCustomerService } from './billing-customer.service';

@Module({
  controllers: [BillingCustomerController],
  providers: [BillingCustomerService],
})
export class BillingCustomerModule {}
