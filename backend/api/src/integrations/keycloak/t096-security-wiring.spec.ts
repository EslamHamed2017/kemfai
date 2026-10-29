import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';

interface RealmClient {
  clientId?: string;
  serviceAccountsEnabled?: boolean;
  publicClient?: boolean;
  standardFlowEnabled?: boolean;
  directAccessGrantsEnabled?: boolean;
  fullScopeAllowed?: boolean;
  secret?: string;
}

interface RealmUser {
  serviceAccountClientId?: string;
  clientRoles?: Record<string, string[]>;
}

interface RealmImport {
  clients?: RealmClient[];
  users?: RealmUser[];
  clientScopeMappings?: Record<string, Array<{ client?: string; roles?: string[] }>>;
}

interface ComposeFile {
  services?: Record<string, { environment?: Record<string, string> }>;
}

const repoRoot = resolve(process.cwd(), '../..');

describe('T096 Keycloak least-privilege wiring', () => {
  const realm = JSON.parse(
    readFileSync(resolve(repoRoot, 'infra/keycloak/kemfai-customers-realm.json'), 'utf8'),
  ) as RealmImport;
  const compose = load(
    readFileSync(resolve(repoRoot, 'infra/docker/docker-compose.yml'), 'utf8'),
  ) as ComposeFile;

  it('defines one confidential, service-account-only client with no full scope', () => {
    const clients = (realm.clients ?? []).filter((client) => client.clientId === 'kemfai-users');
    expect(clients).toHaveLength(1);
    expect(clients[0]).toEqual(
      expect.objectContaining({
        publicClient: false,
        serviceAccountsEnabled: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
        fullScopeAllowed: false,
        secret: '${KEYCLOAK_USERS_CLIENT_SECRET}',
      }),
    );
  });

  it('grants exactly the two required realm-management roles and never realm-admin', () => {
    const users = (realm.users ?? []).filter(
      (user) => user.serviceAccountClientId === 'kemfai-users',
    );
    expect(users).toHaveLength(1);
    expect(users[0].clientRoles).toEqual({
      'realm-management': ['manage-users', 'view-realm'],
    });
    expect(JSON.stringify(users[0])).not.toContain('realm-admin');
    expect(realm.clientScopeMappings?.['realm-management']).toEqual([
      { client: 'kemfai-users', roles: ['manage-users', 'view-realm'] },
    ]);
    expect(JSON.stringify(realm.clientScopeMappings?.['realm-management'])).not.toContain(
      'realm-admin',
    );
  });

  it('passes the same environment-owned secret to realm import and the API', () => {
    const keycloak = compose.services?.keycloak?.environment;
    const api = compose.services?.api?.environment;
    expect(keycloak?.KEYCLOAK_USERS_CLIENT_SECRET).toBe(
      '${KEYCLOAK_USERS_CLIENT_SECRET:?set KEYCLOAK_USERS_CLIENT_SECRET}',
    );
    expect(api?.KEYCLOAK_USERS_CLIENT_ID).toBe('kemfai-users');
    expect(api?.KEMFAI_TRUST_PROXY_HOPS).toBe(1);
    expect(api?.KEYCLOAK_USERS_CLIENT_SECRET).toBe(
      '${KEYCLOAK_USERS_CLIENT_SECRET:?set KEYCLOAK_USERS_CLIENT_SECRET}',
    );
    expect(api?.KEYCLOAK_ADMIN).toBeUndefined();
    expect(api?.KEYCLOAK_ADMIN_PASSWORD).toBeUndefined();
  });
});
