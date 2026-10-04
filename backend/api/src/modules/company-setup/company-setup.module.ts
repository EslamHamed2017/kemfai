import { Module } from '@nestjs/common';
import { CompanySetupController } from './company-setup.controller';

@Module({
  controllers: [CompanySetupController],
})
export class CompanySetupModule {}
