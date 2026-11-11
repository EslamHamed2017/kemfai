/** @jest-environment node */
const forwardAccounting = jest.fn();

jest.mock('../../src/lib/auth/accounting-bff', () => ({
  forwardAccounting: (...args: unknown[]) => forwardAccounting(...args),
}));

import * as collection from '../../src/app/api/accounting/v1/journals/route';
import * as item from '../../src/app/api/accounting/v1/journals/[journalId]/route';

const companyId = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  forwardAccounting.mockReset();
  forwardAccounting.mockResolvedValue(new Response(null, { status: 204 }));
});

describe('T130 journal collection BFF route', () => {
  test('GET preserves the exact safe query and original company context', async () => {
    const query = '?active=false';
    const request = new Request('https://app.test/api/accounting/v1/journals' + query, {
      headers: { 'x-kemfai-company-id': companyId },
    });

    await expect(collection.GET(request)).resolves.toMatchObject({ status: 204 });
    expect(forwardAccounting).toHaveBeenCalledWith(request, {
      method: 'GET',
      path: '/journals' + query,
    });
    expect(request.headers.get('x-kemfai-company-id')).toBe(companyId);
  });

  test('POST delegates the parsed bilingual body and preserves mutation headers', async () => {
    const body = {
      code: 'ADJ',
      name: { en: 'Adjustments', ar: 'التسويات' },
      journalType: 'general',
    };
    const request = new Request('https://app.test/api/accounting/v1/journals', {
      method: 'POST',
      headers: {
        origin: 'https://app.test',
        'content-type': 'application/json',
        'idempotency-key': 'journal-create-1',
        'x-kemfai-company-id': companyId,
      },
      body: JSON.stringify(body),
    });

    await expect(collection.POST(request)).resolves.toMatchObject({ status: 204 });
    expect(forwardAccounting).toHaveBeenCalledWith(request, {
      method: 'POST',
      path: '/journals',
      body,
    });
    expect(request.headers.get('idempotency-key')).toBe('journal-create-1');
    expect(request.headers.get('x-kemfai-company-id')).toBe(companyId);
  });
});

describe('T130 journal item BFF route', () => {
  test('PATCH safely encodes the journal ID and preserves ETag and receipt headers', async () => {
    const body = { name: { en: 'Updated', ar: 'محدث' }, active: false };
    const request = new Request('https://app.test/api/accounting/v1/journals/unsafe', {
      method: 'PATCH',
      headers: {
        origin: 'https://app.test',
        'content-type': 'application/json',
        'idempotency-key': 'journal-update-1',
        'if-match': '"7"',
        'x-kemfai-company-id': companyId,
      },
      body: JSON.stringify(body),
    });
    const context = { params: Promise.resolve({ journalId: '../currencies' }) };

    await expect(item.PATCH(request, context)).resolves.toMatchObject({ status: 204 });
    expect(forwardAccounting).toHaveBeenCalledWith(request, {
      method: 'PATCH',
      path: '/journals/..%2Fcurrencies',
      body,
    });
    expect(request.headers.get('if-match')).toBe('"7"');
    expect(request.headers.get('idempotency-key')).toBe('journal-update-1');
    expect(request.headers.get('x-kemfai-company-id')).toBe(companyId);
  });
});
