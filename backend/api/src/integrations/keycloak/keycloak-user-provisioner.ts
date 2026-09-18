/**
 * Contract for provisioning `kemfai-customers` Keycloak users (T032, FR-018/FR-019).
 *
 * The accounts signup flow depends on this interface only — never on a concrete HTTP
 * client — so integration tests can substitute an in-memory fake (test/support) while the
 * real Admin REST implementation (admin-rest-keycloak-user-provisioner.ts) is unit-tested
 * against an in-process HTTP server. The user id is always pre-allocated by the caller
 * (Account.keycloakUserId) so the control-plane row and the Keycloak identity share one
 * stable identifier and compensation (deleteUser) is always addressable.
 */
export interface CreateKeycloakUserInput {
  /** Pre-allocated Account.keycloakUserId — Keycloak accepts a caller-supplied id on create. */
  id: string;
  email: string;
  password: string;
  /** Keycloak required-action aliases; signup always demands ['VERIFY_EMAIL'] (FR-019). */
  requiredActions: string[];
}

export interface KeycloakUserProvisioner {
  /**
   * Creates the realm user. Rejects with {@link KeycloakUserConflictError} when Keycloak
   * already holds a user with the same email (409) and {@link KeycloakUnavailableError}
   * for every other failure — callers never see raw HTTP transport errors.
   */
  createUser(input: CreateKeycloakUserInput): Promise<void>;

  /**
   * Best-effort compensation delete used only when a later step of the signup saga fails
   * after the user was created. A 404 (user already gone) resolves as success.
   */
  deleteUser(id: string): Promise<void>;
}

/** Injection token — bind the real Admin REST client in KeycloakModule, fakes in tests. */
export const KEYCLOAK_USER_PROVISIONER = 'KEYCLOAK_USER_PROVISIONER';

export class KeycloakUserConflictError extends Error {
  constructor(readonly email: string) {
    super(`Keycloak already holds a user for this email: ${email}`);
    this.name = 'KeycloakUserConflictError';
  }
}

export class KeycloakUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'KeycloakUnavailableError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
