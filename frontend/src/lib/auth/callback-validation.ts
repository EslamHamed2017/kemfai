import { constantTimeEqual } from './pkce';

export function validCallbackParameters(
  queryState: string | null,
  cookieState?: string,
  code?: string | null,
  nonce?: string,
  verifier?: string,
): boolean {
  return Boolean(code && nonce && verifier && constantTimeEqual(queryState, cookieState));
}
