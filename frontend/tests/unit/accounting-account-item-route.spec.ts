/** @jest-environment node */
const forwardAccounting = jest.fn();

jest.mock('../../src/lib/auth/accounting-bff', () => ({
  forwardAccounting: (...args: unknown[]) => forwardAccounting(...args),
}));

import { GET, PATCH } from '../../src/app/api/accounting/v1/accounts/[accountId]/route';

const accountId = '55555555-5555-4555-8555-555555555555';
const context = { params: Promise.resolve({ accountId }) };

beforeEach(() => {
  forwardAccounting.mockReset();
  forwardAccounting.mockResolvedValue(new Response(null, { status: 204 }));
});

test('T058 GET delegates the original request and exact account item path', async () => {
  const request = new Request(`https://app.test/api/accounting/v1/accounts/${accountId}`, {
    headers: { 'x-kemfai-company-id': '22222222-2222-4222-8222-222222222222' },
  });

  await expect(GET(request, context)).resolves.toMatchObject({ status: 204 });
  expect(forwardAccounting).toHaveBeenCalledTimes(1);
  expect(forwardAccounting).toHaveBeenCalledWith(request, {
    method: 'GET',
    path: `/accounts/${accountId}`,
  });
});

test('T058 PATCH preserves conditional and retry headers on the original request and delegates its body', async () => {
  const body = { name: { en: 'Cash on hand', ar: 'النقد في الصندوق' }, active: true };
  const request = new Request(`https://app.test/api/accounting/v1/accounts/${accountId}`, {
    method: 'PATCH',
    headers: {
      origin: 'https://app.test',
      'content-type': 'application/json',
      'idempotency-key': 'account-update-1',
      'if-match': '"6"',
      'x-kemfai-company-id': '22222222-2222-4222-8222-222222222222',
    },
    body: JSON.stringify(body),
  });

  await expect(PATCH(request, context)).resolves.toMatchObject({ status: 204 });
  expect(forwardAccounting).toHaveBeenCalledTimes(1);
  expect(forwardAccounting).toHaveBeenCalledWith(request, {
    method: 'PATCH',
    path: `/accounts/${accountId}`,
    body,
  });
  expect(request.headers.get('if-match')).toBe('"6"');
  expect(request.headers.get('idempotency-key')).toBe('account-update-1');
});

test('T058 encodes a route parameter so it cannot widen the fixed account-item boundary', async () => {
  const request = new Request('https://app.test/api/accounting/v1/accounts/unsafe');

  await GET(request, { params: Promise.resolve({ accountId: '../drafts' }) });

  expect(forwardAccounting).toHaveBeenCalledWith(request, {
    method: 'GET',
    path: '/accounts/..%2Fdrafts',
  });
});
