// Keycloak 26's rendered login DOM and the accepted T056 fixture both establish
// this field identity. Keep it structural so the adjacent Show password control
// and theme-specific label decoration cannot become competing matches.
export const KEYCLOAK_PASSWORD_SELECTOR = 'input#password[name="password"]';

export function isOwnedKeycloakLoginUrl(
  candidate: string,
  issuerValue: string,
  callbackValue: string,
): boolean {
  try {
    const url = new URL(candidate);
    const issuer = new URL(issuerValue);
    const callback = new URL(callbackValue);
    const expectedPath = `${issuer.pathname.replace(/\/$/, '')}/protocol/openid-connect/auth`;
    return (
      url.origin === issuer.origin &&
      url.pathname === expectedPath &&
      url.searchParams.get('client_id') === 'kemfai-internal-ui' &&
      url.searchParams.get('redirect_uri') === callback.toString() &&
      url.searchParams.get('response_type') === 'code' &&
      (url.searchParams.get('scope') ?? '').split(/\s+/).includes('openid') &&
      url.searchParams.get('code_challenge_method') === 'S256' &&
      Boolean(url.searchParams.get('state')) &&
      Boolean(url.searchParams.get('nonce')) &&
      Boolean(url.searchParams.get('code_challenge'))
    );
  } catch {
    return false;
  }
}
