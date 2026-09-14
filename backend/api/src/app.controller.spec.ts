import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('getStatus', () => {
    it('reports the service as ok without touching Odoo or any database', () => {
      expect(appController.getStatus()).toEqual({
        service: 'kemfai-api',
        status: 'ok',
      });
    });
  });
});
