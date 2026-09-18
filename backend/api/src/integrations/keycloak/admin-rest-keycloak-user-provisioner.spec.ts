import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AdminRestKeycloakUserProvisioner } from './admin-rest-keycloak-user-provisioner';
import { KeycloakUnavailableError, KeycloakUserConflictError } from './keycloak-user-provisioner';

/**
 * Unit coverage of the real Keycloak Admin REST client (T032) against an in-process HTTP
 * server implementing the two admin endpoints signup needs — the same fake-server pattern
 * as bearer-auth.guard.spec.ts (fake-keycloak.ts): only the Keycloak itself is fake, the
 * network calls, headers, and payload shapes are real.
 */

interface RecordedRequest {
  method: string;
  url: string;
  authorization?: string;
  contentType?: string;
  body?: string;
}

interface FakeAdminServer {
  baseUrl: string;
  requests: RecordedRequest[];
  tokenStatus: number;
  createStatus: number;
  tokenResponses: number;
  close(): Promise<void>;
}

async function startFakeAdminServer(): Promise<FakeAdminServer> {
  const requests: RecordedRequest[] = [];
  const state: FakeAdminServer = {
    baseUrl: '',
    requests,
    tokenStatus: 200,
    createStatus: 201,
    tokenResponses: 0,
    close: () => Promise.resolve(),
  };

  const httpServer: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '/',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);

      if (req.url?.endsWith('/protocol/openid-connect/token')) {
        res.statusCode = state.tokenStatus;
        res.setHeader('content-type', 'application/json');
        state.tokenResponses += 1;
        res.end(JSON.stringify({ access_token: `token-${state.tokenResponses}`, expires_in: 300 }));
        return;
      }
      if (req.method === 'POST' && req.url?.endsWith('/admin/realms/kemfai-customers/users')) {
        res.statusCode = state.createStatus;
        res.end();
        return;
      }
      if (
        req.method === 'DELETE' &&
        /\/admin\/realms\/kemfai-customers\/users\/[^/]+$/.test(req.url ?? '')
      ) {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address() as AddressInfo;
  state.baseUrl = `http://127.0.0.1:${address.port}`;
  state.close = () => new Promise<void>((resolve) => httpServer.close(() => resolve()));

  return state;
}

const USER_INPUT = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'owner@example.com',
  password: 'a-very-strong-password',
  requiredActions: ['VERIFY_EMAIL'],
};

function envWith(overrides: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  const names = [
    'KEYCLOAK_URL',
    'KEYCLOAK_USERS_CLIENT_ID',
    'KEYCLOAK_USERS_CLIENT_SECRET',
    'KEYCLOAK_ADMIN',
    'KEYCLOAK_ADMIN_PASSWORD',
  ];
  for (const name of names) {
    saved[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  return () => {
    for (const name of names) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  };
}

describe('AdminRestKeycloakUserProvisioner (T032, unit)', () => {
  let server: FakeAdminServer;

  beforeEach(async () => {
    server = await startFakeAdminServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('authenticates with client_credentials when a service client is configured, and sends the documented create payload', async () => {
    const restore = envWith({
      KEYCLOAK_URL: server.baseUrl,
      KEYCLOAK_USERS_CLIENT_ID: 'kemfai-api-admin',
      KEYCLOAK_USERS_CLIENT_SECRET: 'service-secret',
      KEYCLOAK_ADMIN: undefined,
      KEYCLOAK_ADMIN_PASSWORD: undefined,
    });
    try {
      const provisioner = new AdminRestKeycloakUserProvisioner();
      await provisioner.createUser(USER_INPUT);

      const tokenRequest = server.requests.find((r) =>
        r.url.endsWith('/protocol/openid-connect/token'),
      );
      expect(tokenRequest).toBeDefined();
      expect(tokenRequest?.body).toContain('grant_type=client_credentials');
      expect(tokenRequest?.body).toContain('client_id=kemfai-api-admin');
      expect(tokenRequest?.body).toContain('client_secret=service-secret');

      const createRequest = server.requests.find((r) =>
        r.url.endsWith('/admin/realms/kemfai-customers/users'),
      );
      expect(createRequest?.authorization).toBe('Bearer token-1');
      expect(JSON.parse(createRequest?.body ?? '{}')).toEqual({
        id: USER_INPUT.id,
        username: USER_INPUT.email,
        email: USER_INPUT.email,
        enabled: true,
        emailVerified: false,
        requiredActions: ['VERIFY_EMAIL'],
        credentials: [{ type: 'password', value: USER_INPUT.password, temporary: false }],
      });
    } finally {
      restore();
    }
  });

  it('falls back to the dev bootstrap admin (admin-cli password grant) when no service client is configured', async () => {
    const restore = envWith({
      KEYCLOAK_URL: server.baseUrl,
      KEYCLOAK_USERS_CLIENT_ID: undefined,
      KEYCLOAK_USERS_CLIENT_SECRET: undefined,
      KEYCLOAK_ADMIN: 'admin',
      KEYCLOAK_ADMIN_PASSWORD: 'kemfai_dev_admin',
    });
    try {
      const provisioner = new AdminRestKeycloakUserProvisioner();
      await provisioner.createUser(USER_INPUT);

      const tokenRequest = server.requests.find((r) =>
        r.url.endsWith('/protocol/openid-connect/token'),
      );
      expect(tokenRequest?.body).toContain('grant_type=password');
      expect(tokenRequest?.body).toContain('client_id=admin-cli');
      expect(tokenRequest?.body).toContain('username=admin');
    } finally {
      restore();
    }
  });

  it('caches the admin token until near expiry (two calls, one token request)', async () => {
    const restore = envWith({
      KEYCLOAK_URL: server.baseUrl,
      KEYCLOAK_USERS_CLIENT_ID: 'kemfai-api-admin',
      KEYCLOAK_USERS_CLIENT_SECRET: 'service-secret',
      KEYCLOAK_ADMIN: undefined,
      KEYCLOAK_ADMIN_PASSWORD: undefined,
    });
    try {
      const provisioner = new AdminRestKeycloakUserProvisioner();
      await provisioner.createUser(USER_INPUT);
      await provisioner.deleteUser(USER_INPUT.id);

      expect(server.tokenResponses).toBe(1);
    } finally {
      restore();
    }
  });

  it('maps a 409 from user creation to KeycloakUserConflictError', async () => {
    const restore = envWith({
      KEYCLOAK_URL: server.baseUrl,
      KEYCLOAK_USERS_CLIENT_ID: 'kemfai-api-admin',
      KEYCLOAK_USERS_CLIENT_SECRET: 'service-secret',
      KEYCLOAK_ADMIN: undefined,
      KEYCLOAK_ADMIN_PASSWORD: undefined,
    });
    server.createStatus = 409;
    try {
      const provisioner = new AdminRestKeycloakUserProvisioner();
      await expect(provisioner.createUser(USER_INPUT)).rejects.toThrow(KeycloakUserConflictError);
    } finally {
      restore();
    }
  });

  it('maps any other creation failure to KeycloakUnavailableError (never a raw transport error)', async () => {
    const restore = envWith({
      KEYCLOAK_URL: server.baseUrl,
      KEYCLOAK_USERS_CLIENT_ID: 'kemfai-api-admin',
      KEYCLOAK_USERS_CLIENT_SECRET: 'service-secret',
      KEYCLOAK_ADMIN: undefined,
      KEYCLOAK_ADMIN_PASSWORD: undefined,
    });
    server.createStatus = 500;
    try {
      const provisioner = new AdminRestKeycloakUserProvisioner();
      await expect(provisioner.createUser(USER_INPUT)).rejects.toThrow(KeycloakUnavailableError);
    } finally {
      restore();
    }
  });

  it('throws KeycloakUnavailableError before any network call when no admin credentials are configured', async () => {
    const restore = envWith({
      KEYCLOAK_URL: server.baseUrl,
      KEYCLOAK_USERS_CLIENT_ID: undefined,
      KEYCLOAK_USERS_CLIENT_SECRET: undefined,
      KEYCLOAK_ADMIN: undefined,
      KEYCLOAK_ADMIN_PASSWORD: undefined,
    });
    try {
      const provisioner = new AdminRestKeycloakUserProvisioner();
      await expect(provisioner.createUser(USER_INPUT)).rejects.toThrow(KeycloakUnavailableError);
      expect(server.requests).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
