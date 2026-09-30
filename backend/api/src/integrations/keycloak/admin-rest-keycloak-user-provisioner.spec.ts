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
  /** Current per-user state served by GET .../users/{id} (requiredActions preserved across PUTs). */
  users: Map<
    string,
    { emailVerified: boolean; requiredActions: string[]; attributes?: Record<string, string[]> }
  >;
  roles: Map<string, string[]>;
  mappingStatus: number;
  /** Per-user OTP credential list served by GET .../users/{id}/credentials. */
  credentials: Map<string, Array<{ type: string }>>;
  getStatus: number;
  putStatus: number;
  credentialsStatus: number;
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
    users: new Map(),
    roles: new Map(),
    mappingStatus: 204,
    credentials: new Map(),
    getStatus: 200,
    putStatus: 204,
    credentialsStatus: 200,
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
        if (state.createStatus === 201)
          res.setHeader(
            'location',
            `${state.baseUrl}/admin/realms/kemfai-customers/users/${USER_INPUT.id}`,
          );
        res.end();
        return;
      }
      if (req.url?.endsWith('/roles/WorkspaceOwner') && req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'WorkspaceOwner' }),
        );
        return;
      }
      const mappingMatch = /\/users\/([^/]+)\/role-mappings\/realm$/.exec(req.url ?? '');
      if (mappingMatch && ['POST', 'DELETE'].includes(req.method ?? '')) {
        res.statusCode = state.mappingStatus;
        if (state.mappingStatus === 204)
          state.roles.set(mappingMatch[1], req.method === 'POST' ? ['WorkspaceOwner'] : []);
        res.end();
        return;
      }
      const credentialsMatch =
        /\/admin\/realms\/kemfai-customers\/users\/([^/]+)\/credentials$/.exec(req.url ?? '');
      if (req.method === 'GET' && credentialsMatch) {
        if (state.credentialsStatus !== 200) {
          res.statusCode = state.credentialsStatus;
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(state.credentials.get(credentialsMatch[1]) ?? []));
        return;
      }

      const userMatch = /\/admin\/realms\/kemfai-customers\/users\/([^/]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && userMatch) {
        const user = state.users.get(userMatch[1]);
        if (!user || state.getStatus !== 200) {
          res.statusCode = state.getStatus !== 200 ? state.getStatus : 404;
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: userMatch[1], ...user }));
        return;
      }
      if (req.method === 'PUT' && userMatch) {
        if (state.putStatus !== 204) {
          res.statusCode = state.putStatus;
          res.end();
          return;
        }
        const body = JSON.parse(recorded.body ?? '{}') as {
          emailVerified?: boolean;
          requiredActions?: string[];
          attributes?: Record<string, string[]>;
        };
        const existing = state.users.get(userMatch[1]) ?? {
          emailVerified: false,
          requiredActions: [],
        };
        state.users.set(userMatch[1], {
          emailVerified: body.emailVerified ?? existing.emailVerified,
          requiredActions: body.requiredActions ?? existing.requiredActions,
          attributes: body.attributes ?? existing.attributes,
        });
        res.statusCode = 204;
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

  describe('markEmailVerified (T033)', () => {
    const env = () =>
      envWith({
        KEYCLOAK_URL: server.baseUrl,
        KEYCLOAK_USERS_CLIENT_ID: 'kemfai-api-admin',
        KEYCLOAK_USERS_CLIENT_SECRET: 'service-secret',
        KEYCLOAK_ADMIN: undefined,
        KEYCLOAK_ADMIN_PASSWORD: undefined,
      });

    it('sets emailVerified=true and removes ONLY VERIFY_EMAIL, preserving other required actions', async () => {
      server.users.set(USER_INPUT.id, {
        emailVerified: false,
        requiredActions: ['VERIFY_EMAIL', 'CONFIGURE_TOTP'],
      });
      const restore = env();
      try {
        const provisioner = new AdminRestKeycloakUserProvisioner();
        await provisioner.markEmailVerified(USER_INPUT.id);

        const getRequest = server.requests.find(
          (r) => r.method === 'GET' && r.url.endsWith(`/users/${USER_INPUT.id}`),
        );
        expect(getRequest?.authorization).toMatch(/^Bearer token-/);

        const putRequest = server.requests.find(
          (r) => r.method === 'PUT' && r.url.endsWith(`/users/${USER_INPUT.id}`),
        );
        expect(JSON.parse(putRequest?.body ?? '{}')).toEqual({
          emailVerified: true,
          requiredActions: ['CONFIGURE_TOTP'],
        });

        const after = server.users.get(USER_INPUT.id);
        expect(after?.emailVerified).toBe(true);
        expect(after?.requiredActions).toEqual(['CONFIGURE_TOTP']);
      } finally {
        restore();
      }
    });

    it('is idempotent when no other required actions exist', async () => {
      server.users.set(USER_INPUT.id, { emailVerified: false, requiredActions: ['VERIFY_EMAIL'] });
      const restore = env();
      try {
        const provisioner = new AdminRestKeycloakUserProvisioner();
        await provisioner.markEmailVerified(USER_INPUT.id);
        await provisioner.markEmailVerified(USER_INPUT.id);

        const after = server.users.get(USER_INPUT.id);
        expect(after?.emailVerified).toBe(true);
        expect(after?.requiredActions).toEqual([]);
      } finally {
        restore();
      }
    });

    it('maps a GET failure to KeycloakUnavailableError without a PUT', async () => {
      server.getStatus = 500;
      const restore = env();
      try {
        const provisioner = new AdminRestKeycloakUserProvisioner();
        await expect(provisioner.markEmailVerified(USER_INPUT.id)).rejects.toThrow(
          KeycloakUnavailableError,
        );
        expect(server.requests.some((r) => r.method === 'PUT')).toBe(false);
      } finally {
        restore();
        server.getStatus = 200;
      }
    });

    it('maps a PUT failure to KeycloakUnavailableError', async () => {
      server.users.set(USER_INPUT.id, { emailVerified: false, requiredActions: ['VERIFY_EMAIL'] });
      server.putStatus = 500;
      const restore = env();
      try {
        const provisioner = new AdminRestKeycloakUserProvisioner();
        await expect(provisioner.markEmailVerified(USER_INPUT.id)).rejects.toThrow(
          KeycloakUnavailableError,
        );
      } finally {
        restore();
        server.putStatus = 204;
      }
    });
  });

  describe('beginTotpEnrollment (T035)', () => {
    const env = () =>
      envWith({
        KEYCLOAK_URL: server.baseUrl,
        KEYCLOAK_USERS_CLIENT_ID: 'kemfai-api-admin',
        KEYCLOAK_USERS_CLIENT_SECRET: 'service-secret',
        KEYCLOAK_ADMIN: undefined,
        KEYCLOAK_ADMIN_PASSWORD: undefined,
      });

    it('adds CONFIGURE_TOTP while preserving every other required action', async () => {
      server.users.set(USER_INPUT.id, { emailVerified: true, requiredActions: ['SOME_OTHER'] });
      const restore = env();
      try {
        const provisioner = new AdminRestKeycloakUserProvisioner();
        await provisioner.beginTotpEnrollment(USER_INPUT.id);

        const putRequest = server.requests.find(
          (r) => r.method === 'PUT' && r.url.endsWith(`/users/${USER_INPUT.id}`),
        );
        expect(JSON.parse(putRequest?.body ?? '{}')).toEqual({
          requiredActions: ['SOME_OTHER', 'CONFIGURE_TOTP'],
        });
        expect(server.users.get(USER_INPUT.id)?.requiredActions).toEqual([
          'SOME_OTHER',
          'CONFIGURE_TOTP',
        ]);
      } finally {
        restore();
      }
    });

    it('is idempotent — no PUT when CONFIGURE_TOTP is already pending', async () => {
      server.users.set(USER_INPUT.id, {
        emailVerified: true,
        requiredActions: ['CONFIGURE_TOTP'],
      });
      const restore = env();
      try {
        const provisioner = new AdminRestKeycloakUserProvisioner();
        await provisioner.beginTotpEnrollment(USER_INPUT.id);
        expect(server.requests.some((r) => r.method === 'PUT')).toBe(false);
      } finally {
        restore();
      }
    });

    it('maps a GET failure to KeycloakUnavailableError without a PUT', async () => {
      server.getStatus = 500;
      const restore = env();
      try {
        const provisioner = new AdminRestKeycloakUserProvisioner();
        await expect(provisioner.beginTotpEnrollment(USER_INPUT.id)).rejects.toThrow(
          KeycloakUnavailableError,
        );
        expect(server.requests.some((r) => r.method === 'PUT')).toBe(false);
      } finally {
        restore();
        server.getStatus = 200;
      }
    });

    it('maps a PUT failure to KeycloakUnavailableError', async () => {
      server.users.set(USER_INPUT.id, { emailVerified: true, requiredActions: [] });
      server.putStatus = 500;
      const restore = env();
      try {
        const provisioner = new AdminRestKeycloakUserProvisioner();
        await expect(provisioner.beginTotpEnrollment(USER_INPUT.id)).rejects.toThrow(
          KeycloakUnavailableError,
        );
      } finally {
        restore();
        server.putStatus = 204;
      }
    });
  });

  describe('hasActiveTotpCredential (T035)', () => {
    const env = () =>
      envWith({
        KEYCLOAK_URL: server.baseUrl,
        KEYCLOAK_USERS_CLIENT_ID: 'kemfai-api-admin',
        KEYCLOAK_USERS_CLIENT_SECRET: 'service-secret',
        KEYCLOAK_ADMIN: undefined,
        KEYCLOAK_ADMIN_PASSWORD: undefined,
      });

    it('true once Keycloak holds an otp credential', async () => {
      server.credentials.set(USER_INPUT.id, [{ type: 'password' }, { type: 'otp' }]);
      const restore = env();
      try {
        const provisioner = new AdminRestKeycloakUserProvisioner();
        await expect(provisioner.hasActiveTotpCredential(USER_INPUT.id)).resolves.toBe(true);
      } finally {
        restore();
      }
    });

    it('false when no otp credential exists yet', async () => {
      server.credentials.set(USER_INPUT.id, [{ type: 'password' }]);
      const restore = env();
      try {
        const provisioner = new AdminRestKeycloakUserProvisioner();
        await expect(provisioner.hasActiveTotpCredential(USER_INPUT.id)).resolves.toBe(false);
      } finally {
        restore();
      }
    });

    it('maps a fetch failure to KeycloakUnavailableError', async () => {
      server.credentialsStatus = 500;
      const restore = env();
      try {
        const provisioner = new AdminRestKeycloakUserProvisioner();
        await expect(provisioner.hasActiveTotpCredential(USER_INPUT.id)).rejects.toThrow(
          KeycloakUnavailableError,
        );
      } finally {
        restore();
        server.credentialsStatus = 200;
      }
    });
  });
});

describe('WorkspaceOwner Admin REST binding (T046)', () => {
  let server: FakeAdminServer;
  let restore: () => void;
  beforeEach(async () => {
    server = await startFakeAdminServer();
    restore = envWith({
      KEYCLOAK_URL: server.baseUrl,
      KEYCLOAK_USERS_CLIENT_ID: 'test-client',
      KEYCLOAK_USERS_CLIENT_SECRET: 'test-secret',
    });
    server.users.set(USER_INPUT.id, {
      emailVerified: true,
      requiredActions: [],
      attributes: { timezone: ['UTC'] },
    });
  });
  afterEach(async () => {
    restore();
    await server.close();
  });
  it('persists tenant_id without dropping other attributes; maps role; idempotently rebinds; revokes both', async () => {
    const client = new AdminRestKeycloakUserProvisioner();
    await client.assignWorkspaceOwner(USER_INPUT.id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await client.assignWorkspaceOwner(USER_INPUT.id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(server.users.get(USER_INPUT.id)?.attributes).toEqual({
      timezone: ['UTC'],
      tenant_id: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    });
    expect(server.roles.get(USER_INPUT.id)).toEqual(['WorkspaceOwner']);
    await expect(
      client.assignWorkspaceOwner(USER_INPUT.id, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    ).rejects.toThrow(KeycloakUnavailableError);
    await client.revokeWorkspaceOwner(USER_INPUT.id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(server.roles.get(USER_INPUT.id)).toEqual([]);
    expect(server.users.get(USER_INPUT.id)?.attributes).toEqual({ timezone: ['UTC'] });
  });
  it('fails binding when role mapping fails, and compensation clears partial attribute', async () => {
    const client = new AdminRestKeycloakUserProvisioner();
    server.mappingStatus = 503;
    await expect(
      client.assignWorkspaceOwner(USER_INPUT.id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    ).rejects.toThrow(KeycloakUnavailableError);
    expect(server.users.get(USER_INPUT.id)?.attributes?.tenant_id).toBeDefined();
    server.mappingStatus = 204;
    await client.revokeWorkspaceOwner(USER_INPUT.id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(server.users.get(USER_INPUT.id)?.attributes).toEqual({ timezone: ['UTC'] });
  });
});
