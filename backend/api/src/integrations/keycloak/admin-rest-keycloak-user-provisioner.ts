import {
  CreateKeycloakUserInput,
  KeycloakUnavailableError,
  KeycloakUserConflictError,
  KeycloakUserProvisioner,
} from './keycloak-user-provisioner';

/**
 * Real Keycloak Admin REST implementation of {@link KeycloakUserProvisioner} (T032).
 *
 * Config is read from `process.env` on every call (same convention as BearerAuthGuard)
 * so integration/unit tests can point at an in-process fake admin server without a live
 * Keycloak:
 *   - KEYCLOAK_URL (default http://keycloak:8080)
 *   - KEYCLOAK_CUSTOMERS_REALM (default kemfai-customers)
 *   - Admin token: EITHER a scoped service client (KEYCLOAK_USERS_CLIENT_ID +
 *     KEYCLOAK_USERS_CLIENT_SECRET, client_credentials — the production posture), OR the
 *     dev bootstrap admin (KEYCLOAK_ADMIN/KEYCLOAK_ADMIN_PASSWORD via admin-cli, the
 *     credentials already committed to infra/.env.example for local development).
 *
 * User create/delete (T032) and email-verification mirroring (T033) are implemented —
 * the minimum Admin REST surface the accounts saga needs; broader admin capabilities are
 * deliberately not reachable through this class.
 */

interface AdminTokenConfig {
  tokenUrl: string;
  body: URLSearchParams;
}

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

const REQUEST_TIMEOUT_MS = 10_000;
/** Refresh a token this many ms before its nominal expiry so a call never rides a dying token. */
const TOKEN_EXPIRY_SAFETY_MS = 10_000;

function resolveAdminTokenConfig(realm: string, baseUrl: string): AdminTokenConfig | null {
  const clientId = process.env.KEYCLOAK_USERS_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_USERS_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return {
      tokenUrl: `${baseUrl}/realms/${realm}/protocol/openid-connect/token`,
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    };
  }
  const username = process.env.KEYCLOAK_ADMIN;
  const password = process.env.KEYCLOAK_ADMIN_PASSWORD;
  if (username && password) {
    return {
      tokenUrl: `${baseUrl}/realms/${realm}/protocol/openid-connect/token`,
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username,
        password,
      }),
    };
  }
  return null;
}

export class AdminRestKeycloakUserProvisioner implements KeycloakUserProvisioner {
  private cachedToken: CachedToken | null = null;

  private async fetchAdminToken(): Promise<string> {
    const baseUrl = process.env.KEYCLOAK_URL ?? 'http://keycloak:8080';
    const realm = process.env.KEYCLOAK_CUSTOMERS_REALM ?? 'kemfai-customers';
    const config = resolveAdminTokenConfig(realm, baseUrl);
    if (!config) {
      throw new KeycloakUnavailableError(
        'No Keycloak admin credentials configured (set KEYCLOAK_USERS_CLIENT_ID/SECRET or KEYCLOAK_ADMIN/PASSWORD)',
      );
    }

    let response: Response;
    try {
      response = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: config.body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new KeycloakUnavailableError('Keycloak token endpoint is unreachable', error);
    }
    if (!response.ok) {
      throw new KeycloakUnavailableError(`Keycloak token endpoint returned ${response.status}`);
    }
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new KeycloakUnavailableError('Keycloak token response lacked access_token');
    }
    const expiresInMs = (payload.expires_in ?? 60) * 1000;
    this.cachedToken = {
      value: payload.access_token,
      expiresAtMs: Date.now() + expiresInMs - TOKEN_EXPIRY_SAFETY_MS,
    };
    return payload.access_token;
  }

  private async adminToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAtMs > Date.now()) {
      return this.cachedToken.value;
    }
    return this.fetchAdminToken();
  }

  private baseUrl(): string {
    return process.env.KEYCLOAK_URL ?? 'http://keycloak:8080';
  }

  private realm(): string {
    return process.env.KEYCLOAK_CUSTOMERS_REALM ?? 'kemfai-customers';
  }

  async createUser(input: CreateKeycloakUserInput): Promise<void> {
    const token = await this.adminToken();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}/admin/realms/${this.realm()}/users`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: input.id,
          username: input.email,
          email: input.email,
          enabled: true,
          emailVerified: false,
          requiredActions: input.requiredActions,
          credentials: [{ type: 'password', value: input.password, temporary: false }],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new KeycloakUnavailableError('Keycloak user creation is unreachable', error);
    }
    if (response.status === 409) {
      throw new KeycloakUserConflictError(input.email);
    }
    if (!response.ok) {
      throw new KeycloakUnavailableError(`Keycloak user creation returned ${response.status}`);
    }
  }

  async deleteUser(id: string): Promise<void> {
    const token = await this.adminToken();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}/admin/realms/${this.realm()}/users/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new KeycloakUnavailableError('Keycloak user deletion is unreachable', error);
    }
    // 404 = user never existed / already compensated — the caller's goal is already met.
    if (!response.ok && response.status !== 404) {
      throw new KeycloakUnavailableError(`Keycloak user deletion returned ${response.status}`);
    }
  }

  async markEmailVerified(id: string): Promise<void> {
    const token = await this.adminToken();
    const userUrl = `${this.baseUrl()}/admin/realms/${this.realm()}/users/${id}`;

    let user: { requiredActions?: string[] };
    try {
      const response = await fetch(userUrl, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new KeycloakUnavailableError(`Keycloak user fetch returned ${response.status}`);
      }
      user = (await response.json()) as { requiredActions?: string[] };
    } catch (error) {
      if (error instanceof KeycloakUnavailableError) {
        throw error;
      }
      throw new KeycloakUnavailableError('Keycloak user fetch is unreachable', error);
    }

    // Preserve every other required action — only VERIFY_EMAIL is satisfied by this call.
    const remainingActions = (user.requiredActions ?? []).filter(
      (action) => action !== 'VERIFY_EMAIL',
    );

    let response: Response;
    try {
      response = await fetch(userUrl, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          emailVerified: true,
          requiredActions: remainingActions,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new KeycloakUnavailableError('Keycloak user update is unreachable', error);
    }
    if (!response.ok) {
      throw new KeycloakUnavailableError(`Keycloak user update returned ${response.status}`);
    }
  }

  async beginTotpEnrollment(id: string): Promise<void> {
    const token = await this.adminToken();
    const userUrl = `${this.baseUrl()}/admin/realms/${this.realm()}/users/${id}`;

    let user: { requiredActions?: string[] };
    try {
      const response = await fetch(userUrl, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new KeycloakUnavailableError(`Keycloak user fetch returned ${response.status}`);
      }
      user = (await response.json()) as { requiredActions?: string[] };
    } catch (error) {
      if (error instanceof KeycloakUnavailableError) {
        throw error;
      }
      throw new KeycloakUnavailableError('Keycloak user fetch is unreachable', error);
    }

    const existingActions = user.requiredActions ?? [];
    if (existingActions.includes('CONFIGURE_TOTP')) {
      return; // already pending — idempotent no-op, no PUT needed.
    }

    let response: Response;
    try {
      response = await fetch(userUrl, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requiredActions: [...existingActions, 'CONFIGURE_TOTP'],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new KeycloakUnavailableError('Keycloak user update is unreachable', error);
    }
    if (!response.ok) {
      throw new KeycloakUnavailableError(`Keycloak user update returned ${response.status}`);
    }
  }

  async hasActiveTotpCredential(id: string): Promise<boolean> {
    const token = await this.adminToken();
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl()}/admin/realms/${this.realm()}/users/${id}/credentials`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      throw new KeycloakUnavailableError('Keycloak credentials fetch is unreachable', error);
    }
    if (!response.ok) {
      throw new KeycloakUnavailableError(`Keycloak credentials fetch returned ${response.status}`);
    }
    const credentials = (await response.json()) as Array<{ type?: string }>;
    return credentials.some((credential) => credential.type === 'otp');
  }
}
