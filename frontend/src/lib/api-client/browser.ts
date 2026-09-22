import { createApiClient } from './client';
import type { ApiClient } from './client';

let cachedClient: ApiClient | undefined;

/**
 * Browser-side singleton client for unauthenticated pages (signup, verify-email,
 * resend-verification — all `security: []` in the OpenAPI contract). These pages
 * run before any session/auth token exists, so this reads NEXT_PUBLIC_API_URL
 * directly rather than threading a server-issued token through.
 */
export function getBrowserApiClient(): ApiClient {
  if (!cachedClient) {
    cachedClient = createApiClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL ?? '' });
  }
  return cachedClient;
}
