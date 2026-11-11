import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import controlDataSource from '../../src/database/data-source';

type LiveResponse = {
  status: number;
  body: Record<string, unknown>;
  etag: string | null;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`T028 requires exact-owned live fixture variable ${name}`);
  return value;
}

async function call(
  method: string,
  path: string,
  options: {
    body?: Record<string, unknown>;
    idempotencyKey?: string;
    etag?: string;
  } = {},
): Promise<LiveResponse> {
  const response = await fetch(`${required('KEMFAI_AF_API_BASE_URL')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${required('KEMFAI_AF_USER_A_TOKEN')}`,
      'x-kemfai-company-id': required('KEMFAI_AF_COMPANY_A1_ID'),
      'accept-language': 'en',
      'x-correlation-id': randomUUID(),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      ...(options.etag ? { 'if-match': options.etag } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    etag: response.headers.get('etag'),
  };
}

async function odooFault(mode: 'tenant-audit-create-failure' | null): Promise<void> {
  const response = await fetch(`${required('KEMFAI_AF_FAULT_CONTROL_URL')}/fault`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error(`fault controller rejected mode ${mode}: ${response.status}`);
}

async function sendAndDropResponse(path: string, body: Record<string, unknown>, key: string) {
  const endpoint = new URL(required('KEMFAI_AF_API_BASE_URL'));
  if (endpoint.protocol !== 'http:')
    throw new Error('lost-response fixture requires loopback HTTP');
  const payload = JSON.stringify(body);
  const request = [
    `POST ${path} HTTP/1.1`,
    `Host: ${endpoint.host}`,
    `Authorization: Bearer ${required('KEMFAI_AF_USER_A_TOKEN')}`,
    `x-kemfai-company-id: ${required('KEMFAI_AF_COMPANY_A1_ID')}`,
    `x-correlation-id: ${randomUUID()}`,
    `idempotency-key: ${key}`,
    'content-type: application/json',
    `content-length: ${Buffer.byteLength(payload)}`,
    'connection: close',
    '',
    payload,
  ].join('\r\n');
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) }, () =>
      socket.write(request, () => socket.destroy()),
    );
    socket.once('close', () => resolve());
    socket.once('error', reject);
  });
}

async function setPlatformAuditAvailable(available: boolean): Promise<void> {
  await controlDataSource.query(
    available
      ? 'ALTER TABLE "audit_event_t028_outage" RENAME TO "audit_event"'
      : 'ALTER TABLE "audit_event" RENAME TO "audit_event_t028_outage"',
  );
}

function accountPayload(label: string): Record<string, unknown> {
  return {
    code: `T028.${label.replace(/[^A-Za-z0-9]/g, '')}.${randomUUID().slice(0, 8)}`,
    name: { en: `Race ${label}`, ar: `سباق ${label}` },
    accountType: 'asset_current',
    nodeKind: 'posting',
    active: true,
  };
}

function resource(response: LiveResponse): Record<string, unknown> {
  return response.body.resource as Record<string, unknown>;
}

async function handoffRows(key: string): Promise<Array<Record<string, unknown>>> {
  return controlDataSource.query(
    'SELECT * FROM "accounting_mutation_handoff" WHERE "idempotency_key" = $1',
    [key],
  ) as Promise<Array<Record<string, unknown>>>;
}

async function waitForAudited(key: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await handoffRows(key);
    if (rows[0]?.state === 'audited') return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`handoff ${key} did not converge to audited`);
}

describe('Accounting real failure/race recovery (T028)', () => {
  beforeAll(async () => {
    required('KEMFAI_AF_API_BASE_URL');
    required('KEMFAI_AF_FAULT_CONTROL_URL');
    required('KEMFAI_AF_USER_A_TOKEN');
    required('KEMFAI_AF_COMPANY_A1_ID');
    if (!controlDataSource.isInitialized) await controlDataSource.initialize();
    await controlDataSource.runMigrations();
  });

  afterEach(async () => {
    if (process.env.KEMFAI_AF_FAULT_CONTROL_URL) await odooFault(null);
  });

  afterAll(async () => {
    if (controlDataSource.isInitialized) await controlDataSource.destroy();
  });

  it('uses two simultaneous HTTP/Odoo transactions so one account-version writer wins and one is stale', async () => {
    const created = await call('POST', '/v1/accounting/accounts', {
      body: accountPayload('VERSION'),
      idempotencyKey: randomUUID(),
    });
    expect(created.status).toBe(201);
    expect(created.etag).toBeTruthy();
    const id = resource(created).id as string;
    const baseVersion = resource(created).version as number;
    const [left, right] = await Promise.all([
      call('PATCH', `/v1/accounting/accounts/${id}`, {
        body: { name: { en: 'Left', ar: 'يسار' } },
        idempotencyKey: randomUUID(),
        etag: created.etag!,
      }),
      call('PATCH', `/v1/accounting/accounts/${id}`, {
        body: { name: { en: 'Right', ar: 'يمين' } },
        idempotencyKey: randomUUID(),
        etag: created.etag!,
      }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 412]);
    const winner = left.status === 200 ? left : right;
    expect(resource(winner).version).toBe(baseVersion + 1);
  });

  it('uses two simultaneous HTTP/Odoo transactions with one key and returns one receipt/result', async () => {
    const key = randomUUID();
    const body = accountPayload('SAME-KEY');
    const [first, second] = await Promise.all([
      call('POST', '/v1/accounting/accounts', { body, idempotencyKey: key }),
      call('POST', '/v1/accounting/accounts', { body, idempotencyKey: key }),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body).toEqual(second.body);
    expect(await handoffRows(key)).toHaveLength(1);
    expect((await handoffRows(key))[0].state).toBe('audited');
  });

  it('recovers a lost HTTP response from the durable Odoo receipt without a second mutation', async () => {
    const key = randomUUID();
    const body = accountPayload('LOST-RESPONSE');
    await sendAndDropResponse('/v1/accounting/accounts', body, key);
    await waitForAudited(key);
    const replay = await call('POST', '/v1/accounting/accounts', {
      body,
      idempotencyKey: key,
    });
    expect(replay.status).toBe(201);
    expect(await handoffRows(key)).toHaveLength(1);
  });

  it('withholds success during mirror outage then converges exactly once after bounded recovery', async () => {
    const key = randomUUID();
    const body = accountPayload('MIRROR');
    await setPlatformAuditAvailable(false);
    let failed: LiveResponse;
    try {
      failed = await call('POST', '/v1/accounting/accounts', { body, idempotencyKey: key });
    } finally {
      await setPlatformAuditAvailable(true);
    }
    expect(failed.status).toBe(503);
    expect((await handoffRows(key))[0].state).toBe('odoo_committed');
    const replay = await call('POST', '/v1/accounting/accounts', { body, idempotencyKey: key });
    await waitForAudited(key);
    expect(replay.status).toBe(201);
    expect(await handoffRows(key)).toHaveLength(1);
  });

  it('rolls back the tenant mutation/receipt when tenant audit creation fails', async () => {
    const key = randomUUID();
    const payload = accountPayload('TENANT-AUDIT-ROLLBACK');
    await odooFault('tenant-audit-create-failure');
    const failed = await call('POST', '/v1/accounting/accounts', {
      body: payload,
      idempotencyKey: key,
    });
    expect(failed.status).toBe(503);
    await odooFault(null);
    const page = await call('GET', `/v1/accounting/accounts?search=${payload.code as string}`);
    expect(page.status).toBe(200);
    expect(page.body.items).toEqual([]);
  });
});
