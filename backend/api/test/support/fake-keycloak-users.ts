import {
  CreateKeycloakUserInput,
  KeycloakUserConflictError,
  KeycloakUnavailableError,
  KeycloakUserProvisioner,
} from '../../src/integrations/keycloak/keycloak-user-provisioner';

export interface FakeKeycloakUser {
  id: string;
  email: string;
  requiredActions: string[];
}

/**
 * In-memory KeycloakUserProvisioner for HTTP integration tests (T032/T028): mirrors the
 * real client's observable semantics — duplicate emails conflict (409), compensation
 * deletes are recorded, and failure modes are programmable per-test — while the real
 * Admin REST client's wire behavior is covered by its own unit spec.
 */
export class FakeKeycloakUsers implements KeycloakUserProvisioner {
  readonly users = new Map<string, FakeKeycloakUser>();
  readonly deletedUserIds: string[] = [];
  failNextCreate: Error | null = null;

  async createUser(input: CreateKeycloakUserInput): Promise<void> {
    if (this.failNextCreate) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      throw error;
    }
    for (const user of this.users.values()) {
      if (user.email === input.email) {
        throw new KeycloakUserConflictError(input.email);
      }
    }
    this.users.set(input.id, {
      id: input.id,
      email: input.email,
      requiredActions: [...input.requiredActions],
    });
  }

  async deleteUser(id: string): Promise<void> {
    this.deletedUserIds.push(id);
    this.users.delete(id);
  }

  survivingUsers(): FakeKeycloakUser[] {
    return [...this.users.values()];
  }

  userByEmail(email: string): FakeKeycloakUser | undefined {
    return this.survivingUsers().find((user) => user.email === email);
  }

  /** Drives the compensation path exercised by the failure-atomicity tests. */
  unavailable(message = 'fake keycloak down'): void {
    this.failNextCreate = new KeycloakUnavailableError(message);
  }

  reset(): void {
    this.users.clear();
    this.deletedUserIds.length = 0;
    this.failNextCreate = null;
  }
}
