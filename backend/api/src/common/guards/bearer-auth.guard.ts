import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * A request that has passed {@link BearerAuthGuard}. `auth.keycloakUserId` is the JWT `sub`
 * claim — the only trusted identity signal callers may key account/tenant/plan lookups on.
 * Nothing else in the token payload (custom claims, roles) is propagated, so a caller cannot
 * smuggle a tenant/plan override through the token itself.
 */
export interface AuthenticatedRequest extends Request {
  auth: { keycloakUserId: string };
}

const remoteJwksByUri = new Map<string, JWTVerifyGetKey>();

function resolveJwks(jwksUri: string): JWTVerifyGetKey {
  let jwks = remoteJwksByUri.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    remoteJwksByUri.set(jwksUri, jwks);
  }
  return jwks;
}

/**
 * Config is read from `process.env` on every call (not cached at module load) so integration
 * tests can point at a per-test, in-process JWKS server via KEYCLOAK_JWKS_URI/KEYCLOAK_ISSUER/
 * KEYCLOAK_API_AUDIENCE without needing a live Keycloak.
 */
function resolveAuthConfig() {
  const keycloakUrl = process.env.KEYCLOAK_URL ?? 'http://keycloak:8080';
  const realm = process.env.KEYCLOAK_CUSTOMERS_REALM ?? 'kemfai-customers';
  const issuer = process.env.KEYCLOAK_ISSUER ?? `${keycloakUrl}/realms/${realm}`;
  const audience = process.env.KEYCLOAK_API_AUDIENCE ?? 'kemfai-api';
  const jwksUri = process.env.KEYCLOAK_JWKS_URI ?? `${issuer}/protocol/openid-connect/certs`;
  return { issuer, audience, jwksUri };
}

/**
 * Verifies a Keycloak-issued access token's RS256 signature AND its `iss`/`aud` claims (a
 * validly-signed token minted for a different realm or a different API client MUST be rejected —
 * signature validity alone is not sufficient, since Keycloak's JWKS endpoint is shared across
 * every client registered in a realm, and a realm can back more than one audience).
 */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    const { issuer, audience, jwksUri } = resolveAuthConfig();

    let sub: string | undefined;
    try {
      const { payload } = await jwtVerify(token, resolveJwks(jwksUri), {
        issuer,
        audience,
        algorithms: ['RS256'],
      });
      sub = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }

    if (!sub) {
      throw new UnauthorizedException('Access token is missing a subject claim');
    }

    req.auth = { keycloakUserId: sub };
    return true;
  }
}
