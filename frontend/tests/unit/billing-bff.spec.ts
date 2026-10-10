/** @jest-environment node */
import type { AuthConfig } from '../../src/lib/auth/config';
import {
  getBillingSubscriptionWith,
  getPaymentSubmissionsWith,
  postPaymentSubmissionWith,
} from '../../src/lib/auth/billing-bff';
import type { SessionStore, StoredSession } from '../../src/lib/auth/session-store';

const MAX_PAYMENT_MULTIPART_BYTES = 10 * 1024 * 1024 + 64 * 1024;

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
  accessToken: 'owner-token',
  refreshToken: 'private',
  accessExpiresAt: Date.now() + 3_600_000,
  refreshExpiresAt: Date.now() + 7_200_000,
};
const store: SessionStore = {
  create: async () => 'owner',
  get: async (id) => (id === 'owner' ? session : null),
  tryAcquireRefreshLock: async () => true,
  releaseRefreshLock: async () => undefined,
  rotateIfCurrent: async () => true,
  destroyIfCurrent: async () => true,
  destroy: async () => undefined,
};
const deps = (sessionId: string | undefined, fetcher: typeof fetch) => ({
  config,
  sessionId,
  store,
  fetcher,
});

test('billing reads use fixed upstream paths and keep the bearer token server-side', async () => {
  const fetcher = jest.fn(async (url: string) =>
    Response.json(url.endsWith('/subscription') ? { status: 'PendingActivation' } : []),
  ) as unknown as typeof fetch;

  expect((await getBillingSubscriptionWith(deps('owner', fetcher))).status).toBe(200);
  expect((await getPaymentSubmissionsWith(deps('owner', fetcher))).status).toBe(200);
  expect(fetcher).toHaveBeenNthCalledWith(
    1,
    'https://api.test/billing/subscription',
    expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer owner-token' }),
      cache: 'no-store',
    }),
  );
  expect(fetcher).toHaveBeenNthCalledWith(
    2,
    'https://api.test/billing/payment-submissions',
    expect.objectContaining({ method: 'GET' }),
  );
});

test('proof upload rejects a missing or foreign Origin before reading or forwarding the body', async () => {
  const fetcher = jest.fn();
  for (const origin of [undefined, 'https://evil.test']) {
    const request = new Request('https://app.test/api/billing/payment-submissions', {
      method: 'POST',
      headers: {
        ...(origin ? { origin } : {}),
        'content-type': 'multipart/form-data; boundary=t063-private-boundary',
      },
      body: '--t063-private-boundary--',
    });
    expect((await postPaymentSubmissionWith(request, deps('owner', fetcher))).status).toBe(403);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

test('proof upload authenticates the session before reading any multipart bytes', async () => {
  const fetcher = jest.fn();
  const request = new Request('https://app.test/api/billing/payment-submissions', {
    method: 'POST',
    headers: {
      origin: 'https://app.test',
      'content-type': 'multipart/form-data; boundary=t063-private-boundary',
    },
    body: '--t063-private-boundary--',
  });
  const readBody = jest.spyOn(request, 'arrayBuffer');

  const result = await postPaymentSubmissionWith(request, deps(undefined, fetcher));

  expect(result.status).toBe(401);
  expect(readBody).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

test('proof upload rejects an oversized multipart stream before upstream fetch', async () => {
  const fetcher = jest.fn();
  const request = new Request('https://app.test/api/billing/payment-submissions', {
    method: 'POST',
    headers: {
      origin: 'https://app.test',
      'content-type': 'multipart/form-data; boundary=t063-private-boundary',
    },
    body: Buffer.alloc(MAX_PAYMENT_MULTIPART_BYTES + 1),
  });

  const result = await postPaymentSubmissionWith(request, deps('owner', fetcher));

  expect(result.status).toBe(422);
  expect(await result.json()).toMatchObject({ code: 'PAYMENT_PROOF_TOO_LARGE' });
  expect(fetcher).not.toHaveBeenCalled();
});

test('proof upload forwards the authenticated multipart bytes without an idempotency key', async () => {
  const multipart = '--t063-private-boundary\r\ncontent-disposition: form-data; name="bankReference"\r\n\r\nreference\r\n--t063-private-boundary--';
  const fetchMock = jest.fn<Promise<Response>, Parameters<typeof fetch>>(async () =>
    Response.json({ status: 'PendingReview' }, { status: 201 }),
  );
  const fetcher = fetchMock as typeof fetch;
  const request = new Request('https://app.test/api/billing/payment-submissions', {
    method: 'POST',
    headers: {
      origin: 'https://app.test',
      'content-type': 'multipart/form-data; boundary=t063-private-boundary',
      'idempotency-key': 'must-not-cross-the-multipart-boundary',
    },
    body: multipart,
  });

  const result = await postPaymentSubmissionWith(request, deps('owner', fetcher));

  expect(result.status).toBe(201);
  const [, init] = fetchMock.mock.calls[0];
  const headers = new Headers(init?.headers);
  expect(headers.get('authorization')).toBe('Bearer owner-token');
  expect(headers.get('content-type')).toBe('multipart/form-data; boundary=t063-private-boundary');
  expect(headers.has('idempotency-key')).toBe(false);
  expect(Buffer.from(init?.body as ArrayBuffer)).toHaveLength(Buffer.byteLength(multipart));
});

test('billing network failures are generic and never expose upstream details', async () => {
  const fetcher = jest.fn(async () => {
    throw new Error('private upstream address');
  }) as unknown as typeof fetch;

  const result = await getBillingSubscriptionWith(deps('owner', fetcher));

  expect(result.status).toBe(502);
  expect(await result.text()).not.toContain('private upstream address');
});
