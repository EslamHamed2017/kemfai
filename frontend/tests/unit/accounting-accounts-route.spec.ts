/** @jest-environment node */
const forwardAccounting = jest.fn();

jest.mock('../../src/lib/auth/accounting-bff', () => ({
  forwardAccounting: (...args: unknown[]) => forwardAccounting(...args),
}));

import { GET, POST } from '../../src/app/api/accounting/v1/accounts/route';

beforeEach(() => {
  forwardAccounting.mockReset();
  forwardAccounting.mockResolvedValue(new Response(null, { status: 204 }));
});

test('T057 GET delegates the original request and exact collection query to the authenticated accounting BFF', async () => {
  const request = new Request(
    'https://app.test/api/accounting/v1/accounts?active=true&parentId=11111111-1111-4111-8111-111111111111',
    {
      headers: { 'x-kemfai-company-id': '22222222-2222-4222-8222-222222222222' },
    },
  );

  await expect(GET(request)).resolves.toMatchObject({ status: 204 });
  expect(forwardAccounting).toHaveBeenCalledTimes(1);
  expect(forwardAccounting).toHaveBeenCalledWith(request, {
    method: 'GET',
    path: '/accounts?active=true&parentId=11111111-1111-4111-8111-111111111111',
  });
});

test('T057 POST delegates the original request and parsed body to the authenticated accounting BFF', async () => {
  const body = {
    code: '1000',
    name: { en: 'Cash', ar: 'نقد' },
    nodeKind: 'posting',
  };
  const request = new Request('https://app.test/api/accounting/v1/accounts', {
    method: 'POST',
    headers: {
      origin: 'https://app.test',
      'content-type': 'application/json',
      'idempotency-key': 'create-account-1',
      'x-kemfai-company-id': '22222222-2222-4222-8222-222222222222',
    },
    body: JSON.stringify(body),
  });

  await expect(POST(request)).resolves.toMatchObject({ status: 204 });
  expect(forwardAccounting).toHaveBeenCalledTimes(1);
  expect(forwardAccounting).toHaveBeenCalledWith(request, {
    method: 'POST',
    path: '/accounts',
    body,
  });
});
