jest.mock('@nestjs/core', () => ({ NestFactory: { create: jest.fn() } }));
jest.mock('./database/data-source', () => ({
  __esModule: true,
  default: { isInitialized: false, initialize: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('./openapi/openapi-contract', () => ({ setupOpenApi: jest.fn() }));

import { NestFactory } from '@nestjs/core';
import controlDataSource from './database/data-source';
import { bootstrap } from './bootstrap';

describe('production bootstrap', () => {
  it('initializes the control datasource before accepting HTTP traffic', async () => {
    const app = { enableShutdownHooks: jest.fn(), listen: jest.fn().mockResolvedValue(undefined) };
    (NestFactory.create as jest.Mock).mockResolvedValue(app);

    await bootstrap();

    expect(controlDataSource.initialize).toHaveBeenCalledTimes(1);
    expect((controlDataSource.initialize as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      app.listen.mock.invocationCallOrder[0],
    );
  });
});
