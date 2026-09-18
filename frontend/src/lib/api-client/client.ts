import createClient from 'openapi-fetch';
import type { paths } from './schema';

export type GetAuthToken = () => string | undefined;

export interface CreateApiClientOptions {
  baseUrl: string;
  getAuthToken?: GetAuthToken;
}

/**
 * Typed API client for the KEMFAI BFF, generated from contracts/openapi.yaml (T024).
 * Every path/method/request/response type below is derived from `./schema.ts` —
 * no manual `any` overrides.
 */
export function createApiClient({ baseUrl, getAuthToken }: CreateApiClientOptions) {
  const client = createClient<paths>({ baseUrl });

  client.use({
    onRequest({ request }) {
      const token = getAuthToken?.();
      if (token) {
        request.headers.set('Authorization', `Bearer ${token}`);
      }
      return request;
    },
  });

  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;
