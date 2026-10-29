jest.mock('@nestjs/core', () => ({ NestFactory: { create: jest.fn() } }));
jest.mock('./database/data-source', () => ({
  __esModule: true,
  default: { isInitialized: false, initialize: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('./openapi/openapi-contract', () => ({ setupOpenApi: jest.fn() }));

import { NestFactory } from '@nestjs/core';
import controlDataSource from './database/data-source';
import { bootstrap, configuredTrustProxyHops } from './bootstrap';

function appDouble() {
  const express = { set: jest.fn() };
  return {
    app: {
      getHttpAdapter: jest.fn(() => ({ getInstance: () => express })),
      enableShutdownHooks: jest.fn(),
      listen: jest.fn().mockResolvedValue(undefined),
    },
    express,
  };
}

describe('production bootstrap', () => {
  beforeEach(() => {
    delete process.env.KEMFAI_TRUST_PROXY_HOPS;
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.KEMFAI_TRUST_PROXY_HOPS;
  });

  it('initializes the control datasource before accepting HTTP traffic', async () => {
    const { app } = appDouble();
    (NestFactory.create as jest.Mock).mockResolvedValue(app);

    await bootstrap();

    expect(controlDataSource.initialize).toHaveBeenCalledTimes(1);
    expect((controlDataSource.initialize as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      app.listen.mock.invocationCallOrder[0],
    );
  });

  it('trusts only the explicitly configured number of reverse-proxy hops', async () => {
    process.env.KEMFAI_TRUST_PROXY_HOPS = '1';
    const { app, express } = appDouble();
    (NestFactory.create as jest.Mock).mockResolvedValue(app);

    await bootstrap();

    expect(express.set).toHaveBeenCalledWith('trust proxy', 1);
  });

  it.each(['0', '-1', '1.5', '6', 'all'])('rejects unsafe trust-proxy value %s', (value) => {
    process.env.KEMFAI_TRUST_PROXY_HOPS = value;
    expect(() => configuredTrustProxyHops()).toThrow(
      'KEMFAI_TRUST_PROXY_HOPS must be an integer between 1 and 5',
    );
  });
});
