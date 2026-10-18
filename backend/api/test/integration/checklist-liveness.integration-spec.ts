/** T079 owned-stack HTTP -> normal Nest -> real tenant Odoo liveness proof. */
const live = process.env.KEMFAI_LIVE_T079 === '1' ? describe : describe.skip;
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
};

async function rpc(database: string, service: string, method: string, args: unknown[]) {
  const response = await fetch(`${required('T079_ODOO_URL')}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service, method, args },
      id: 1,
    }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

live('T079 checklist liveness on owned Odoo databases', () => {
  const state = async (token: string) => {
    const response = await fetch(`${required('T079_API_URL')}/onboarding/checklist`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<Record<string, boolean>>;
  };
  const execute = async (db: string, model: string, method: string, args: unknown[]) => {
    const password = required('T079_ODOO_PASSWORD');
    const uid = await rpc(db, 'common', 'login', [db, 'admin', password]);
    return rpc(db, 'object', 'execute_kw', [db, uid, password, model, method, args]);
  };

  it('creates, archives/deletes, and automatically reverses each derived signal', async () => {
    const db = required('T079_ODOO_DB_A');
    const token = required('T079_TOKEN_A');
    expect(await state(token)).toMatchObject({
      customerAdded: false,
      bankAdded: false,
      productAdded: false,
      firstInvoiceReady: false,
    });
    const company = Number(((await execute(db, 'res.company', 'search', [[]])) as number[])[0]);
    const customer = Number(
      await execute(db, 'res.partner', 'create', [
        { name: 'T079 Customer', customer_rank: 1, company_id: company },
      ]),
    );
    expect((await state(token)).customerAdded).toBe(true);
    await execute(db, 'res.partner', 'unlink', [[customer]]);
    expect((await state(token)).customerAdded).toBe(false);
    const companyPartner = Number(
      (
        (await execute(db, 'res.company', 'read', [[company], ['partner_id']])) as Array<{
          partner_id: [number, string];
        }>
      )[0].partner_id[0],
    );
    const bank = Number(
      await execute(db, 'res.partner.bank', 'create', [
        { acc_number: 'T079-ACCOUNT', partner_id: companyPartner },
      ]),
    );
    expect((await state(token)).bankAdded).toBe(true);
    await execute(db, 'res.partner.bank', 'unlink', [[bank]]);
    expect((await state(token)).bankAdded).toBe(false);
    const product = Number(
      await execute(db, 'product.product', 'create', [
        { name: 'T079 Service', sale_ok: true, company_id: company },
      ]),
    );
    expect((await state(token)).productAdded).toBe(true);
    await execute(db, 'product.product', 'write', [[product], { active: false }]);
    expect((await state(token)).productAdded).toBe(false);
  });

  it('uses the signed owner identity to select one tenant database', async () => {
    const a = await state(required('T079_TOKEN_A'));
    const b = await state(required('T079_TOKEN_B'));
    expect({ ...a, gatedOnSubscriptionActivation: undefined }).toEqual({
      ...b,
      gatedOnSubscriptionActivation: undefined,
    });
    expect(a.gatedOnSubscriptionActivation).toBe(true);
    expect(b.gatedOnSubscriptionActivation).toBe(false);
    expect(required('T079_ODOO_DB_A')).not.toBe(required('T079_ODOO_DB_B'));
  });
});
