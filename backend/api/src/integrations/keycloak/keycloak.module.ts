import { Module } from '@nestjs/common';
import { AdminRestKeycloakUserProvisioner } from './admin-rest-keycloak-user-provisioner';
import { KEYCLOAK_USER_PROVISIONER } from './keycloak-user-provisioner';

/**
 * Binds the real Keycloak Admin REST user provisioner (T032). Integration tests override
 * the {@link KEYCLOAK_USER_PROVISIONER} token with an in-memory fake — production wiring
 * stays exactly what this module provides.
 */
@Module({
  providers: [{ provide: KEYCLOAK_USER_PROVISIONER, useClass: AdminRestKeycloakUserProvisioner }],
  exports: [KEYCLOAK_USER_PROVISIONER],
})
export class KeycloakModule {}
