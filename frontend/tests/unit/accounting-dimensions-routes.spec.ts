/** @jest-environment node */
const forwardAccounting = jest.fn();

jest.mock('../../src/lib/auth/accounting-bff', () => ({
  forwardAccounting: (...args: unknown[]) => forwardAccounting(...args),
}));

import * as definitionCollection from '../../src/app/api/accounting/v1/dimension-definitions/route';
import * as definitionItem from '../../src/app/api/accounting/v1/dimension-definitions/[definitionId]/route';
import * as valueCollection from '../../src/app/api/accounting/v1/dimension-values/route';
import * as valueItem from '../../src/app/api/accounting/v1/dimension-values/[valueId]/route';
import * as ruleCollection from '../../src/app/api/accounting/v1/dimension-rules/route';
import * as ruleItem from '../../src/app/api/accounting/v1/dimension-rules/[ruleId]/route';

const companyId = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  forwardAccounting.mockReset();
  forwardAccounting.mockResolvedValue(new Response(null, { status: 204 }));
});

const collections = [
  {
    name: 'definition',
    path: 'dimension-definitions',
    route: definitionCollection,
    query: '?active=true',
    body: { key: 'channel', name: { en: 'Channel', ar: 'القناة' } },
  },
  {
    name: 'value',
    path: 'dimension-values',
    route: valueCollection,
    query: '?definitionId=33333333-3333-4333-8333-333333333333&active=false&cursor=next%2Bpage',
    body: { definitionId: '33333333-3333-4333-8333-333333333333', code: 'PRJ-1' },
  },
  {
    name: 'rule',
    path: 'dimension-rules',
    route: ruleCollection,
    query: '?accountId=44444444-4444-4444-8444-444444444444&transactionType=manual_journal',
    body: { dimensionDefinitionId: '33333333-3333-4333-8333-333333333333', requirement: 'required' },
  },
] as const;

describe.each(collections)('T096 $name collection BFF route', ({ path, route, query, body }) => {
  test('GET preserves the exact safe query and original company context', async () => {
    const request = new Request(`https://app.test/api/accounting/v1/${path}${query}`, {
      headers: { 'x-kemfai-company-id': companyId },
    });

    await expect(route.GET(request)).resolves.toMatchObject({ status: 204 });
    expect(forwardAccounting).toHaveBeenCalledWith(request, {
      method: 'GET',
      path: `/${path}${query}`,
    });
  });

  test('POST delegates the parsed body while preserving receipt headers on the original request', async () => {
    const request = new Request(`https://app.test/api/accounting/v1/${path}`, {
      method: 'POST',
      headers: {
        origin: 'https://app.test',
        'content-type': 'application/json',
        'idempotency-key': `${path}-create-1`,
        'x-kemfai-company-id': companyId,
      },
      body: JSON.stringify(body),
    });

    await expect(route.POST(request)).resolves.toMatchObject({ status: 204 });
    expect(forwardAccounting).toHaveBeenCalledWith(request, {
      method: 'POST',
      path: `/${path}`,
      body,
    });
    expect(request.headers.get('idempotency-key')).toBe(`${path}-create-1`);
    expect(request.headers.get('x-kemfai-company-id')).toBe(companyId);
  });
});

const items = [
  { name: 'definition', path: 'dimension-definitions', param: 'definitionId', route: definitionItem },
  { name: 'value', path: 'dimension-values', param: 'valueId', route: valueItem },
  { name: 'rule', path: 'dimension-rules', param: 'ruleId', route: ruleItem },
] as const;

describe.each(items)('T096 $name item BFF route', ({ path, param, route }) => {
  test('PATCH safely encodes the item parameter and preserves ETag/retry headers', async () => {
    const body = { active: false };
    const request = new Request(`https://app.test/api/accounting/v1/${path}/unsafe`, {
      method: 'PATCH',
      headers: {
        origin: 'https://app.test',
        'content-type': 'application/json',
        'idempotency-key': `${path}-update-1`,
        'if-match': '"7"',
        'x-kemfai-company-id': companyId,
      },
      body: JSON.stringify(body),
    });
    const context = { params: Promise.resolve({ [param]: '../accounts' }) } as never;

    await expect(route.PATCH(request, context)).resolves.toMatchObject({ status: 204 });
    expect(forwardAccounting).toHaveBeenCalledWith(request, {
      method: 'PATCH',
      path: `/${path}/..%2Faccounts`,
      body,
    });
    expect(request.headers.get('if-match')).toBe('"7"');
    expect(request.headers.get('idempotency-key')).toBe(`${path}-update-1`);
  });
});
