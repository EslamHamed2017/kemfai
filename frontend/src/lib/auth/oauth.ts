import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthConfig } from './config';
import type { StoredSession } from './session-store';

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  id_token?: string;
}

const jwksByUri = new Map<string, JWTVerifyGetKey>();

function jwksFor(uri: string): JWTVerifyGetKey {
  let jwks = jwksByUri.get(uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(uri));
    jwksByUri.set(uri, jwks);
  }
  return jwks;
}

async function verifyIdToken(config: AuthConfig, token: string, nonce: string): Promise<void> {
  const { payload } = await jwtVerify(token, jwksFor(config.jwksUri), {
    algorithms: ['RS256'],
    issuer: config.issuer,
    audience: config.clientId,
  });
  if (typeof payload.exp !== 'number') throw new Error('OIDC ID token expiry is required');
  if (payload.azp !== undefined && payload.azp !== config.clientId) {
    throw new Error('OIDC authorized party validation failed');
  }
  if (typeof payload.nonce !== 'string' || payload.nonce !== nonce) {
    throw new Error('OIDC nonce validation failed');
  }
}

async function tokenRequest(config: AuthConfig, body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(`${config.backchannelUrl}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('OIDC token exchange failed');
  return (await response.json()) as TokenResponse;
}

function stored(tokens: TokenResponse, previousRefreshToken?: string): StoredSession {
  if (!tokens.access_token || !(tokens.refresh_token ?? previousRefreshToken)) {
    throw new Error('OIDC response omitted required tokens');
  }
  const now = Date.now();
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previousRefreshToken!,
    accessExpiresAt: now + Math.max(1, tokens.expires_in ?? 60) * 1000,
    refreshExpiresAt: now + Math.max(1, tokens.refresh_expires_in ?? 300) * 1000,
  };
}

export async function exchangeCode(
  config: AuthConfig,
  code: string,
  verifier: string,
  expectedNonce: string,
): Promise<StoredSession> {
  const tokens = await tokenRequest(config, new URLSearchParams({
    grant_type: 'authorization_code', client_id: config.clientId, code,
    redirect_uri: config.redirectUri, code_verifier: verifier,
  }));
  if (!tokens.id_token) throw new Error('OIDC response omitted ID token');
  await verifyIdToken(config, tokens.id_token, expectedNonce);
  return stored(tokens);
}

export async function refreshSession(config: AuthConfig, current: StoredSession): Promise<StoredSession> {
  const tokens = await tokenRequest(config, new URLSearchParams({
    grant_type: 'refresh_token', client_id: config.clientId, refresh_token: current.refreshToken,
  }));
  return stored(tokens, current.refreshToken);
}
