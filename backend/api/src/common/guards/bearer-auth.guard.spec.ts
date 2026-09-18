import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { FakeKeycloak, startFakeKeycloak } from '../../../test/support/fake-keycloak';
import { AuthenticatedRequest, BearerAuthGuard } from './bearer-auth.guard';

function contextWithHeader(header?: string): ExecutionContext {
  const req = { headers: header ? { authorization: header } : {} } as AuthenticatedRequest;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('BearerAuthGuard (T010)', () => {
  const issuer = 'http://127.0.0.1/realms/kemfai-customers-test';
  const audience = 'kemfai-api-test';
  let keycloak: FakeKeycloak;

  beforeAll(async () => {
    keycloak = await startFakeKeycloak({ issuer, audience });
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_API_AUDIENCE = audience;
    process.env.KEYCLOAK_JWKS_URI = keycloak.jwksUri;
  });

  afterAll(async () => {
    await keycloak.close();
    delete process.env.KEYCLOAK_ISSUER;
    delete process.env.KEYCLOAK_API_AUDIENCE;
    delete process.env.KEYCLOAK_JWKS_URI;
  });

  it('rejects a request with no Authorization header', async () => {
    const guard = new BearerAuthGuard();
    await expect(guard.canActivate(contextWithHeader())).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a non-bearer Authorization header', async () => {
    const guard = new BearerAuthGuard();
    await expect(guard.canActivate(contextWithHeader('Basic dXNlcjpwYXNz'))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a malformed token', async () => {
    const guard = new BearerAuthGuard();
    await expect(guard.canActivate(contextWithHeader('Bearer not-a-jwt'))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepts a validly signed token with the expected issuer/audience and exposes sub', async () => {
    const token = await keycloak.signAccessToken({ sub: 'user-abc' });
    const guard = new BearerAuthGuard();
    const context = contextWithHeader(`Bearer ${token}`);

    await expect(guard.canActivate(context)).resolves.toBe(true);

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    expect(req.auth).toEqual({ keycloakUserId: 'user-abc' });
  });

  it('rejects a validly signed token minted by a different issuer (wrong realm)', async () => {
    const token = await keycloak.signAccessToken({
      sub: 'user-abc',
      issuer: 'http://attacker.example.com/realms/other',
    });
    const guard = new BearerAuthGuard();
    await expect(guard.canActivate(contextWithHeader(`Bearer ${token}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a validly signed token minted for a different audience (wrong client)', async () => {
    const token = await keycloak.signAccessToken({
      sub: 'user-abc',
      audience: 'some-other-client',
    });
    const guard = new BearerAuthGuard();
    await expect(guard.canActivate(contextWithHeader(`Bearer ${token}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    const token = await keycloak.signAccessToken({ sub: 'user-abc', expiresIn: '-10s' });
    const guard = new BearerAuthGuard();
    await expect(guard.canActivate(contextWithHeader(`Bearer ${token}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
