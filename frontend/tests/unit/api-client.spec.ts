/**
 * @jest-environment node
 *
 * Uses the Node test environment (not jsdom) because this suite exercises the
 * generated fetch-based API client and needs the real global fetch/Request/Response
 * implementations; jsdom does not implement the Fetch API.
 */
import { createApiClient } from '@/lib/api-client';
import type { components } from '@/lib/api-client';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api-client (T024)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('issues a typed GET against a generated path and returns the parsed schema shape', async () => {
    const plans: components['schemas']['PlanSummary'][] = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        name: { en: 'Starter', ar: 'المبتدئة' },
        monthlyPrice: 10,
        annualPrice: 100,
        currency: 'USD',
        features: [
          { key: 'invoicing', name: { en: 'Invoicing', ar: 'الفوترة' }, limitValue: null },
        ],
      },
    ];
    const fetchMock = jest.fn(async (request: Request) => {
      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://api.kemfai.example/v1/public/plans');
      return jsonResponse(plans);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = createApiClient({ baseUrl: 'https://api.kemfai.example/v1' });
    const { data, error } = await client.GET('/public/plans');

    expect(error).toBeUndefined();
    expect(data).toEqual(plans);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the request body for the PATCH /accounts/me/locale contract path (T113) and requires no manual any', async () => {
    let capturedBody: unknown;
    const fetchMock = jest.fn(async (request: Request) => {
      expect(request.method).toBe('PATCH');
      expect(request.url).toBe('https://api.kemfai.example/v1/accounts/me/locale');
      capturedBody = JSON.parse(await request.text());
      return jsonResponse({});
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = createApiClient({ baseUrl: 'https://api.kemfai.example/v1' });
    const localeUpdate: components['schemas']['LocaleUpdateRequest'] = { locale: 'ar' };
    const { error } = await client.PATCH('/accounts/me/locale', {
      body: localeUpdate,
    });

    expect(error).toBeUndefined();
    expect(capturedBody).toEqual({ locale: 'ar' });
  });

  it('attaches a bearer token from getAuthToken when present, and omits it when absent', async () => {
    const capturedAuthHeaders: Array<string | null> = [];
    const fetchMock = jest.fn(async (request: Request) => {
      capturedAuthHeaders.push(request.headers.get('Authorization'));
      return jsonResponse([]);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    let token: string | undefined = 'test-token';
    const client = createApiClient({
      baseUrl: 'https://api.kemfai.example/v1',
      getAuthToken: () => token,
    });

    await client.GET('/public/plans');
    token = undefined;
    await client.GET('/public/plans');

    expect(capturedAuthHeaders).toEqual(['Bearer test-token', null]);
  });
});
