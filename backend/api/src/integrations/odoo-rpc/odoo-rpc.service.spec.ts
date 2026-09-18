import { OdooRpcService } from './odoo-rpc.service';
import type { OdooRpcClientLike } from './odoo-rpc-client';

type Resolver = (args: unknown[]) => Promise<unknown> | unknown;

class FakeOdooRpcClient implements OdooRpcClientLike {
  public readonly calls: Array<{ service: string; method: string; args: unknown[] }> = [];

  constructor(private readonly resolvers: Record<string, Resolver>) {}

  async call(service: string, method: string, args: unknown[]): Promise<unknown> {
    this.calls.push({ service, method, args });
    const resolver = this.resolvers[`${service}.${method}`];
    return resolver ? resolver(args) : undefined;
  }
}

/**
 * T026: proves the acceptance criterion directly - opening a session against an
 * arbitrary `kemfai_tenant_<id>` db passed at call time, with no shared/global session
 * that could leak a previous tenant's db context into a later (or concurrent) call.
 */
describe('OdooRpcService (T026)', () => {
  it('authenticate() logs in against the exact database passed at call time', async () => {
    const client = new FakeOdooRpcClient({ 'common.login': () => 501 });
    const service = new OdooRpcService(client);

    const uid = await service.authenticate('kemfai_tenant_a', 'admin', 'secret-a');

    expect(uid).toBe(501);
    expect(client.calls).toEqual([
      { service: 'common', method: 'login', args: ['kemfai_tenant_a', 'admin', 'secret-a'] },
    ]);
  });

  it('authenticate() throws rather than returning a falsy uid on bad credentials', async () => {
    const client = new FakeOdooRpcClient({ 'common.login': () => false });
    const service = new OdooRpcService(client);

    await expect(service.authenticate('kemfai_tenant_a', 'admin', 'wrong')).rejects.toThrow(
      'kemfai_tenant_a',
    );
  });

  it('executeKw() threads database/uid/password/model through to object.execute_kw', async () => {
    const client = new FakeOdooRpcClient({ 'object.execute_kw': () => [{ id: 1 }] });
    const service = new OdooRpcService(client);

    const result = await service.executeKw(
      'kemfai_tenant_a',
      501,
      'secret-a',
      'res.partner',
      'search_read',
      [[]],
      { fields: ['id'] },
    );

    expect(result).toEqual([{ id: 1 }]);
    expect(client.calls).toEqual([
      {
        service: 'object',
        method: 'execute_kw',
        args: [
          'kemfai_tenant_a',
          501,
          'secret-a',
          'res.partner',
          'search_read',
          [[]],
          { fields: ['id'] },
        ],
      },
    ]);
  });

  it('never leaks one tenant db context into a concurrent authenticate() for another tenant', async () => {
    const uidByDb: Record<string, number> = {
      kemfai_tenant_a: 501,
      kemfai_tenant_b: 777,
    };
    const client = new FakeOdooRpcClient({
      'common.login': async ([db]: unknown[]) => {
        const database = db as string;
        // Tenant A's login response arrives slower than tenant B's, simulating
        // out-of-order network I/O. If the service stashed the db/uid on `this`
        // instead of threading it through the call, this ordering would surface it.
        if (database === 'kemfai_tenant_a') {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return uidByDb[database];
      },
    });
    const service = new OdooRpcService(client);

    const [uidA, uidB] = await Promise.all([
      service.authenticate('kemfai_tenant_a', 'admin', 'secret-a'),
      service.authenticate('kemfai_tenant_b', 'admin', 'secret-b'),
    ]);

    expect(uidA).toBe(501);
    expect(uidB).toBe(777);

    const resultA = await service.executeKw(
      'kemfai_tenant_a',
      uidA,
      'secret-a',
      'res.partner',
      'search_read',
    );
    const resultB = await service.executeKw(
      'kemfai_tenant_b',
      uidB,
      'secret-b',
      'res.partner',
      'search_read',
    );
    void resultA;
    void resultB;

    expect(client.calls.filter((c) => c.method === 'login')).toEqual([
      { service: 'common', method: 'login', args: ['kemfai_tenant_a', 'admin', 'secret-a'] },
      { service: 'common', method: 'login', args: ['kemfai_tenant_b', 'admin', 'secret-b'] },
    ]);
    expect(client.calls.filter((c) => c.method === 'execute_kw').map((c) => c.args[0])).toEqual([
      'kemfai_tenant_a',
      'kemfai_tenant_b',
    ]);
  });
});
