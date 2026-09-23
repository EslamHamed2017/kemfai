export const SESSION_COOKIE = '__Host-kemfai_session';
export const STATE_COOKIE = '__Host-kemfai_oidc_state';
export const NONCE_COOKIE = '__Host-kemfai_oidc_nonce';
export const VERIFIER_COOKIE = '__Host-kemfai_pkce_verifier';
export const RETURN_TO_COOKIE = '__Host-kemfai_oidc_return_to';

export const secureCookie = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
};

export const TRANSIENT_COOKIE_MAX_AGE = 300;
