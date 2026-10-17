/** @jest-environment node */
import type { AuthConfig } from '../../src/lib/auth/config';
import {
  getBillingReviewQueueWith,
  postBillingDecisionWith,
} from '../../src/lib/auth/billing-admin-bff';
import type { SessionStore, StoredSession } from '../../src/lib/auth/session-store';

const config: AuthConfig = {
  issuer: 'https://id.test/realms/internal',
  backchannelUrl: 'https://id.test/realms/internal',
  jwksUri: 'https://id.test/certs',
  clientId: 'billing-admin',
  redirectUri: 'https://app.test/internal-auth/callback',
  apiUrl: 'https://api.test',
  redisUrl: 'redis://test',
};
const session: StoredSession = {
  accessToken: 'internal-token',
  refreshToken: 'secret',
  accessExpiresAt: Date.now() + 3600000,
  refreshExpiresAt: Date.now() + 7200000,
};
const store: SessionStore = {
  create: async () => 'i',
  get: async (id) => (id === 'i' ? session : null),
  tryAcquireRefreshLock: async () => true,
  releaseRefreshLock: async () => undefined,
  rotateIfCurrent: async () => true,
  destroyIfCurrent: async () => true,
  destroy: async () => undefined,
};
const deps = (fetcher: typeof fetch, sessionId: string | undefined = 'i') => ({
  config,
  store,
  sessionId,
  fetcher,
});

test('queue uses only the fixed internal endpoint and keeps the internal bearer server-side', async () => {
  const fetcher = jest.fn(async () => Response.json([])) as unknown as typeof fetch;
  expect((await getBillingReviewQueueWith(deps(fetcher))).status).toBe(200);
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.test/internal/billing/review-queue',
    expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer internal-token' }),
      cache: 'no-store',
    }),
  );
});

test.each([
  [
    'approve',
    undefined,
    undefined,
    {
      submissionId: '11111111-1111-4111-8111-111111111111',
      subscriptionId: '22222222-2222-4222-8222-222222222222',
      status: 'Active',
      billingPeriodStart: '2026-10-01',
      billingPeriodEnd: '2026-10-31',
      activatedAt: '2026-10-16T12:00:00.000Z',
    },
  ],
  [
    'reject',
    { reason: 'Mismatch' },
    { reason: 'Mismatch' },
    {
      submissionId: '11111111-1111-4111-8111-111111111111',
      status: 'Rejected',
      decision: 'reject',
      decisionNotes: 'Mismatch',
      decidedAt: '2026-10-16T12:00:00.000Z',
    },
  ],
  [
    'request-more-info',
    { details: 'Upload a clearer receipt' },
    { details: 'Upload a clearer receipt' },
    {
      submissionId: '11111111-1111-4111-8111-111111111111',
      status: 'MoreInfoRequested',
      decision: 'more_info',
      decisionNotes: 'Upload a clearer receipt',
      decidedAt: '2026-10-16T12:00:00.000Z',
    },
  ],
] as const)(
  '%s forwards the exact contract and approval is bodyless',
  async (action, input, expected, result) => {
    const fetchMock = jest.fn<Promise<Response>, Parameters<typeof fetch>>(async () =>
      Response.json(result),
    );
    const request = new Request(
      `https://app.test/api/internal/billing/payment-submissions/11111111-1111-4111-8111-111111111111/${action}`,
      {
        method: 'POST',
        headers: { origin: 'https://app.test', 'content-type': 'application/json' },
        body: input ? JSON.stringify(input) : undefined,
      },
    );
    expect(
      (
        await postBillingDecisionWith(
          request,
          '11111111-1111-4111-8111-111111111111',
          action,
          deps(fetchMock as typeof fetch),
        )
      ).status,
    ).toBe(200);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toBe(expected ? JSON.stringify(expected) : undefined);
  },
);

test.each([
  ['approve', Response.json({})],
  [
    'approve',
    new Response('<html>upstream proxy</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  ],
  ['approve', new Response('{', { status: 200, headers: { 'content-type': 'application/json' } })],
  [
    'approve',
    Response.json({
      submissionId: '11111111-1111-4111-8111-111111111111',
      status: 'Rejected',
      decision: 'reject',
      decisionNotes: 'wrong action',
      decidedAt: '2026-10-16T12:00:00.000Z',
    }),
  ],
  [
    'reject',
    Response.json({
      submissionId: '11111111-1111-4111-8111-111111111111',
      subscriptionId: '22222222-2222-4222-8222-222222222222',
      status: 'Active',
      billingPeriodStart: '2026-10-01',
      billingPeriodEnd: '2026-10-31',
      activatedAt: '2026-10-16T12:00:00.000Z',
    }),
  ],
  [
    'request-more-info',
    Response.json({
      submissionId: '11111111-1111-4111-8111-111111111111',
      status: 'Rejected',
      decision: 'reject',
      decisionNotes: 'wrong status',
      decidedAt: '2026-10-16T12:00:00.000Z',
    }),
  ],
] as const)(
  'sanitizes malformed or action-mismatched %s success as unknown outcome',
  async (action, upstreamResponse) => {
    const fetcher = jest.fn(async () => upstreamResponse) as unknown as typeof fetch;
    const note =
      action === 'reject'
        ? { reason: 'reason' }
        : action === 'request-more-info'
          ? { details: 'details' }
          : undefined;
    const request = new Request('https://app.test/x', {
      method: 'POST',
      headers: { origin: 'https://app.test', 'content-type': 'application/json' },
      body: note ? JSON.stringify(note) : undefined,
    });
    const result = await postBillingDecisionWith(
      request,
      '11111111-1111-4111-8111-111111111111',
      action as 'approve' | 'reject' | 'request-more-info',
      deps(fetcher),
    );
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ code: 'UNKNOWN_OUTCOME' });
  },
);

test('decisions reject foreign origin, invalid ids, blank notes, and oversized notes without forwarding', async () => {
  const fetcher = jest.fn() as unknown as typeof fetch;
  const cases = [
    new Request('https://app.test/x', { method: 'POST', headers: { origin: 'https://evil.test' } }),
    new Request('https://app.test/x', {
      method: 'POST',
      headers: { origin: 'https://app.test', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '  ' }),
    }),
    new Request('https://app.test/x', {
      method: 'POST',
      headers: { origin: 'https://app.test', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'x'.repeat(4001) }),
    }),
  ];
  expect((await postBillingDecisionWith(cases[0], 'bad', 'approve', deps(fetcher))).status).toBe(
    403,
  );
  expect(
    (
      await postBillingDecisionWith(
        cases[1],
        '11111111-1111-4111-8111-111111111111',
        'reject',
        deps(fetcher),
      )
    ).status,
  ).toBe(422);
  expect(
    (
      await postBillingDecisionWith(
        cases[2],
        '11111111-1111-4111-8111-111111111111',
        'reject',
        deps(fetcher),
      )
    ).status,
  ).toBe(422);
  expect(fetcher).not.toHaveBeenCalled();
});

test('upstream bodies and transport details are never exposed on failures', async () => {
  const fetcher = jest.fn(async () => {
    throw new Error('token and private host');
  }) as unknown as typeof fetch;
  const result = await getBillingReviewQueueWith(deps(fetcher));
  expect(result.status).toBe(502);
  expect(await result.text()).not.toMatch(/token|private host/);
});
