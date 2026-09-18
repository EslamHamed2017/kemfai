import { createOdooRpcClient, resolveOdooConfig } from './odoo-rpc-client';

const ENV_KEY = 'KEMFAI_ODOO_URL';

/**
 * T026: `resolveOdooConfig` is the only place `KEMFAI_ODOO_URL` is parsed, mirroring
 * `resolveMinioConfig`'s env-per-call pattern (minio-client.ts) so tests never depend on
 * a live Odoo server. `KEMFAI_ODOO_URL` (not `ODOO_URL`) is the variable name
 * infra/docker/docker-compose.yml and infra/.env.example actually set.
 */
describe('resolveOdooConfig (T026)', () => {
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('falls back to the host-Odoo dev default when KEMFAI_ODOO_URL is unset', () => {
    delete process.env[ENV_KEY];
    expect(resolveOdooConfig()).toEqual({ baseUrl: 'http://localhost:8069' });
  });

  it('reads the docker-compose-supplied KEMFAI_ODOO_URL', () => {
    process.env[ENV_KEY] = 'http://kemfai-odoo:8069';
    expect(resolveOdooConfig()).toEqual({ baseUrl: 'http://kemfai-odoo:8069' });
  });
});

describe('createOdooRpcClient (T026)', () => {
  const original = process.env[ENV_KEY];
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    process.env[ENV_KEY] = 'http://kemfai-odoo:8069';
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('posts a JSON-RPC 2.0 envelope to {baseUrl}/jsonrpc and returns the result', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 42 }), { status: 200 }),
    );

    const client = createOdooRpcClient();
    const result = await client.call('common', 'login', ['kemfai_tenant_a', 'admin', 'secret']);

    expect(result).toBe(42);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://kemfai-odoo:8069/jsonrpc');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body.method).toBe('call');
    expect(body.params).toEqual({
      service: 'common',
      method: 'login',
      args: ['kemfai_tenant_a', 'admin', 'secret'],
    });
  });

  it('throws when Odoo returns a JSON-RPC error envelope', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { message: 'Odoo Server Error', data: { message: 'Access Denied' } },
        }),
        { status: 200 },
      ),
    );

    const client = createOdooRpcClient();
    await expect(
      client.call('common', 'login', ['kemfai_tenant_a', 'admin', 'wrong']),
    ).rejects.toThrow('Access Denied');
  });

  it('throws when the HTTP response itself is not ok', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 503 }));

    const client = createOdooRpcClient();
    await expect(
      client.call('common', 'login', ['kemfai_tenant_a', 'admin', 'secret']),
    ).rejects.toThrow('HTTP 503');
  });
});
