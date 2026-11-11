/** @jest-environment node */
import type { AuthConfig } from '../../src/lib/auth/config';
import {
  forwardAccountingWith,
  type AccountingBffDependencies,
} from '../../src/lib/auth/accounting-bff';
import type { SessionStore, StoredSession } from '../../src/lib/auth/session-store';

const config: AuthConfig = {
  issuer: 'https://id.test',
  backchannelUrl: 'https://id.test',
  jwksUri: 'https://id.test/certs',
  clientId: 'client',
  redirectUri: 'https://app.test/auth/callback',
  apiUrl: 'https://api.test',
  redisUrl: 'redis://test',
};
const session: StoredSession = {
  accessToken: 'alice-token',
  refreshToken: 'private',
  accessExpiresAt: Date.now() + 3_600_000,
  refreshExpiresAt: Date.now() + 7_200_000,
};
const store: SessionStore = {
  create: async () => 'alice',
  get: async (id) => (id === 'alice' ? session : null),
  tryAcquireRefreshLock: async () => true,
  releaseRefreshLock: async () => undefined,
  rotateIfCurrent: async () => true,
  destroyIfCurrent: async () => true,
  destroy: async () => undefined,
};
const deps = (
  fetcher: typeof fetch,
  sessionId: string | undefined = 'alice',
): AccountingBffDependencies => ({ config, sessionId, store, fetcher });
const request = (method: string, headers: Record<string, string> = {}) =>
  new Request('https://app.test/api/accounting/v1/accounts', { method, headers });
function expectExpiredSessionCookie(response: Response): void {
  const value = response.headers.get('set-cookie');
  expect(value).toMatch(/^__Host-kemfai_session=;/);
  expect(value).toContain('Secure');
  expect(value).toContain('HttpOnly');
  expect(value).toContain('Path=/');
  expect(value).toContain('Max-Age=0');
  expect(value).not.toContain('Domain=');
}

test('requires a valid server session and clears an expired session without upstream access', async () => {
  const fetcher = jest.fn() as unknown as typeof fetch;
  expect(
    (
      await forwardAccountingWith(
        request('GET'),
        { method: 'GET', path: '/accounts' },
        { ...deps(fetcher), sessionId: undefined },
      )
    ).status,
  ).toBe(401);
  const expired = await forwardAccountingWith(
    request('GET'),
    { method: 'GET', path: '/accounts' },
    deps(fetcher, 'expired'),
  );
  expect(expired.status).toBe(401);
  expectExpiredSessionCookie(expired);
  expect(fetcher).not.toHaveBeenCalled();
});

test('forwards only authenticated accounting context and preserves company, locale, and correlation', async () => {
  const fetcher = jest.fn(async () => Response.json({ items: [] })) as unknown as typeof fetch;
  const incoming = request('GET', {
    cookie: 'private-browser-cookie',
    'x-kemfai-company-id': '11111111-1111-4111-8111-111111111111',
    'accept-language': 'ar',
    'x-correlation-id': '22222222-2222-4222-8222-222222222222',
  });
  expect(
    (
      await forwardAccountingWith(
        incoming,
        { method: 'GET', path: '/accounts?active=true' },
        deps(fetcher),
      )
    ).status,
  ).toBe(200);
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.test/v1/accounting/accounts?active=true',
    expect.objectContaining({
      method: 'GET',
      cache: 'no-store',
      headers: {
        authorization: 'Bearer alice-token',
        accept: 'application/json',
        'x-kemfai-company-id': '11111111-1111-4111-8111-111111111111',
        'accept-language': 'ar',
        'x-correlation-id': '22222222-2222-4222-8222-222222222222',
      },
    }),
  );
});

test('rejects missing company context and cross-origin mutations before upstream access', async () => {
  const fetcher = jest.fn() as unknown as typeof fetch;
  const noCompany = await forwardAccountingWith(
    request('GET'),
    { method: 'GET', path: '/accounts' },
    deps(fetcher),
  );
  expect(noCompany.status).toBe(400);
  expect(await noCompany.json()).toMatchObject({ code: 'ACCOUNTING_COMPANY_REQUIRED' });
  for (const origin of [undefined, 'https://evil.test']) {
    const headers: Record<string, string> = {
      'x-kemfai-company-id': '11111111-1111-4111-8111-111111111111',
    };
    if (origin) headers.origin = origin;
    expect(
      (
        await forwardAccountingWith(
          request('POST', headers),
          { method: 'POST', path: '/accounts', body: { code: '1000' } },
          deps(fetcher),
        )
      ).status,
    ).toBe(403);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

test('preserves idempotency, If-Match, JSON body, strong ETag, and receipt fields exactly', async () => {
  const receipt = {
    operationId: '33333333-3333-4333-8333-333333333333',
    auditEventId: '44444444-4444-4444-8444-444444444444',
    correlationId: '22222222-2222-4222-8222-222222222222',
    replayed: true,
    resource: { id: '55555555-5555-4555-8555-555555555555', version: 7, exactAmount: '100.2300' },
  };
  const fetcher = jest.fn(async () =>
    Response.json(receipt, { headers: { etag: '"7"' } }),
  ) as unknown as typeof fetch;
  const incoming = request('PATCH', {
    origin: 'https://app.test',
    'x-kemfai-company-id': '11111111-1111-4111-8111-111111111111',
    'accept-language': 'en',
    'x-correlation-id': '22222222-2222-4222-8222-222222222222',
    'idempotency-key': 'account-edit-0001',
    'if-match': '"6"',
  });
  const body = { name: { en: 'Cash', ar: 'نقد' }, exactAmount: '100.2300' };
  const response = await forwardAccountingWith(
    incoming,
    { method: 'PATCH', path: '/accounts/55555555-5555-4555-8555-555555555555', body },
    deps(fetcher),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('etag')).toBe('"7"');
  expect(await response.json()).toEqual(receipt);
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.test/v1/accounting/accounts/55555555-5555-4555-8555-555555555555',
    expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: expect.objectContaining({
        'idempotency-key': 'account-edit-0001',
        'if-match': '"6"',
        'content-type': 'application/json',
      }),
    }),
  );
});

test('preserves a documented safe error envelope but sanitizes malformed or transport failures', async () => {
  const safeError = {
    statusCode: 412,
    code: 'ACCOUNT_VERSION_STALE',
    messageKey: 'accounting.errors.accountVersionStale',
    correlationId: '22222222-2222-4222-8222-222222222222',
    issues: [{ code: 'CONFIGURATION_STALE', messageKey: 'accounting.errors.configurationStale' }],
  };
  const headers = {
    'x-kemfai-company-id': '11111111-1111-4111-8111-111111111111',
    'x-correlation-id': '22222222-2222-4222-8222-222222222222',
  };
  const safe = await forwardAccountingWith(
    request('GET', headers),
    { method: 'GET', path: '/accounts/x' },
    deps(jest.fn(async () => Response.json(safeError, { status: 412 })) as unknown as typeof fetch),
  );
  expect(safe.status).toBe(412);
  expect(await safe.json()).toEqual(safeError);
  const unsafe = await forwardAccountingWith(
    request('GET', headers),
    { method: 'GET', path: '/accounts' },
    deps(
      jest.fn(async () =>
        Response.json({ message: 'odoo model res.company at db tenant_a' }, { status: 500 }),
      ) as unknown as typeof fetch,
    ),
  );
  expect(unsafe.status).toBe(502);
  expect(await unsafe.text()).not.toMatch(/odoo|res\.company|tenant_a/i);
  const failed = await forwardAccountingWith(
    request('GET', headers),
    { method: 'GET', path: '/accounts' },
    deps(
      jest.fn(async () => {
        throw new Error('private RPC host');
      }) as unknown as typeof fetch,
    ),
  );
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toMatch(/private|rpc/i);
});

test('maps a standard Nest precondition error to a safe 412 accounting envelope', async () => {
  const correlationId = '22222222-2222-4222-8222-222222222222';
  const response = await forwardAccountingWith(
    request('GET', {
      'x-kemfai-company-id': '11111111-1111-4111-8111-111111111111',
      'x-correlation-id': correlationId,
    }),
    { method: 'GET', path: '/accounts/55555555-5555-4555-8555-555555555555' },
    deps(
      jest.fn(async () =>
        Response.json(
          {
            statusCode: 412,
            message: 'Precondition Failed',
            error: 'Precondition Failed',
          },
          { status: 412 },
        ),
      ) as unknown as typeof fetch,
    ),
  );

  expect(response.status).toBe(412);
  expect(await response.json()).toEqual({
    statusCode: 412,
    code: 'ACCOUNTING_PRECONDITION_FAILED',
    messageKey: 'accounting.errors.staleConflict',
    correlationId,
  });
});

test('rejects paths outside the fixed accounting API boundary', async () => {
  const fetcher = jest.fn() as unknown as typeof fetch;
  const headers = { 'x-kemfai-company-id': '11111111-1111-4111-8111-111111111111' };
  for (const path of ['https://odoo.test/jsonrpc', '/../internal', '/accounts#fragment'])
    expect(
      (await forwardAccountingWith(request('GET', headers), { method: 'GET', path }, deps(fetcher)))
        .status,
    ).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
