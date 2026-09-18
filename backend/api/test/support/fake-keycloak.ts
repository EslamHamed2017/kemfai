import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

export interface SignAccessTokenOptions {
  sub: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
}

export interface FakeKeycloak {
  jwksUri: string;
  signAccessToken(options: SignAccessTokenOptions): Promise<string>;
  close(): Promise<void>;
}

/**
 * Starts an in-process HTTP server serving a real JWKS document over a real (localhost) network
 * call, so BearerAuthGuard's `createRemoteJWKSet` fetch path is genuinely exercised by tests
 * rather than mocked away — the only thing "fake" here is that it isn't the real Keycloak.
 */
export async function startFakeKeycloak(defaults: {
  issuer: string;
  audience: string;
}): Promise<FakeKeycloak> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const kid = 'fake-keycloak-test-key';
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const server: Server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const jwksUri = `http://127.0.0.1:${address.port}/protocol/openid-connect/certs`;

  return {
    jwksUri,
    async signAccessToken(options: SignAccessTokenOptions): Promise<string> {
      return new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid })
        .setSubject(options.sub)
        .setIssuer(options.issuer ?? defaults.issuer)
        .setAudience(options.audience ?? defaults.audience)
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? '10m')
        .sign(privateKey);
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
