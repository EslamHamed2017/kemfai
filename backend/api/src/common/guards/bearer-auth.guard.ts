import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * A request that has passed {@link BearerAuthGuard}. `auth.keycloakUserId` is the JWT `sub`
 * claim — the only trusted identity signal callers may key account/tenant/plan lookups on.
 * `auth.roles` carries the verified token's `realm_access.roles` claim (RoleGuard's input,
 * T018) — nothing else in the token payload is propagated, so a caller cannot smuggle a
 * tenant/plan override through the token itself. The signed tenant_id is retained only for
 * comparison with the control-plane tenant, never as a lookup override.
 */
export interface AuthenticatedRequest extends Request {
  auth: { keycloakUserId: string; roles: string[]; tenantId?: string | null };
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
function resolveAuthConfig(internalBillingRoute: boolean) {
  const keycloakUrl = process.env.KEYCLOAK_URL ?? 'http://keycloak:8080';
  if (internalBillingRoute) {
    const realm = process.env.KEYCLOAK_INTERNAL_REALM ?? 'kemfai-internal';
    const issuer = process.env.KEYCLOAK_INTERNAL_ISSUER ?? `${keycloakUrl}/realms/${realm}`;
    const audience =
      process.env.KEYCLOAK_INTERNAL_API_AUDIENCE ??
      process.env.KEYCLOAK_API_AUDIENCE ??
      'kemfai-api';
    const jwksUri =
      process.env.KEYCLOAK_INTERNAL_JWKS_URI ?? `${issuer}/protocol/openid-connect/certs`;
    return { issuer, audience, jwksUri };
  }
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
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Routes marked @Public() (plan list, signup, health…) are exempt from bearer auth;
    // every other route is authenticated globally so that the equally global
    // TenantScopeGuard (registered after this guard in AppModule) can rely on req.auth
    // being populated when it runs.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    const path = req.path ?? req.originalUrl ?? req.url ?? '';
    const internalBillingRoute =
      path === '/internal/billing' || path.startsWith('/internal/billing/');
    const { issuer, audience, jwksUri } = resolveAuthConfig(internalBillingRoute);

    let sub: string | undefined;
    let roles: string[] = [];
    let tenantId: string | null = null;
    try {
      const { payload } = await jwtVerify(token, resolveJwks(jwksUri), {
        issuer,
        audience,
        algorithms: ['RS256'],
      });
      sub = payload.sub;
      tenantId = typeof payload['tenant_id'] === 'string' ? payload['tenant_id'] : null;
      const realmAccess = payload['realm_access'] as { roles?: unknown } | undefined;
      if (realmAccess && Array.isArray(realmAccess.roles)) {
        roles = realmAccess.roles.filter((role): role is string => typeof role === 'string');
      }
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }

    if (!sub) {
      throw new UnauthorizedException('Access token is missing a subject claim');
    }

    req.auth = { keycloakUserId: sub, roles, tenantId };
    return true;
  }
}
