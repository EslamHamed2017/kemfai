import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EntitlementsModule } from './modules/entitlements/entitlements.module';

@Module({
  imports: [EntitlementsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
