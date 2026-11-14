/** @jest-environment node */
const forwardAccounting = jest.fn();

jest.mock('../../src/lib/auth/accounting-bff', () => ({
  forwardAccounting: (...args: unknown[]) => forwardAccounting(...args),
}));

import * as collection from '../../src/app/api/accounting/v1/currencies/route';
import * as item from '../../src/app/api/accounting/v1/currencies/[currencyCode]/route';

const companyId = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  forwardAccounting.mockReset();
  forwardAccounting.mockResolvedValue(new Response(null, { status: 204 }));
});

describe('T131 currency collection BFF route', () => {
  test('GET preserves the exact enabled filter and original company context', async () => {
    const query = '?enabled=false';
    const request = new Request('https://app.test/api/accounting/v1/currencies' + query, {
      headers: { 'x-kemfai-company-id': companyId },
    });

    await expect(collection.GET(request)).resolves.toMatchObject({ status: 204 });
    expect(forwardAccounting).toHaveBeenCalledWith(request, {
      method: 'GET',
      path: '/currencies' + query,
    });
    expect(request.headers.get('x-kemfai-company-id')).toBe(companyId);
  });
});

describe('T131 currency item BFF route', () => {
  test.each(['*', '"7"'])(
    'PUT preserves %s precondition, receipt headers, and immutable metadata',
    async (ifMatch) => {
      const body = {
        enabled: true,
        currencyCode: 'USD',
        nativeDecimalPlaces: 2,
        nativeMetadataVersion: 'iso-4217-v1',
        isBase: false,
      };
      const request = new Request('https://app.test/api/accounting/v1/currencies/unsafe', {
        method: 'PUT',
        headers: {
          origin: 'https://app.test',
          'content-type': 'application/json',
          'idempotency-key': 'currency-put-1',
          'if-match': ifMatch,
          'x-kemfai-company-id': companyId,
        },
        body: JSON.stringify(body),
      });
      const context = { params: Promise.resolve({ currencyCode: '../USD' }) };

      await expect(item.PUT(request, context)).resolves.toMatchObject({ status: 204 });
      expect(forwardAccounting).toHaveBeenCalledWith(request, {
        method: 'PUT',
        path: '/currencies/..%2FUSD',
        body,
      });
      expect(request.headers.get('if-match')).toBe(ifMatch);
      expect(request.headers.get('idempotency-key')).toBe('currency-put-1');
      expect(request.headers.get('x-kemfai-company-id')).toBe(companyId);
    },
  );
});
