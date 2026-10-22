import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'kemfai:requiredRoles';

/** Every role in the Roles & Scopes table (data-model.md, cross-cutting FR-002–FR-006). */
export type Role =
  | 'WorkspaceOwner'
  | 'BillingAdmin'
  | 'Support'
  | 'SuperAdmin'
  | 'CustomerSuccess'
  | 'TechnicalAdmin'
  | 'ReadOnlyManagement';

/**
 * Roles that only exist in the `kemfai-internal` realm — never assignable to a
 * `kemfai-customers` Account (FR-004, realm separation enforced in T016's Keycloak exports).
 * RoleGuard and TenantScopeGuard both consult this list: internal identities are exempt from
 * TenantScopeGuard's customer-tenant-isolation check because most internal roles are
 * cross-tenant by design, and Support's narrower per-tenant grant scope is enforced by
 * RoleGuard instead (data-model.md "Cross-cutting: Roles & Scopes").
 */
export const INTERNAL_ROLES: readonly Role[] = [
  'BillingAdmin',
  'Support',
  'SuperAdmin',
  'CustomerSuccess',
  'TechnicalAdmin',
  'ReadOnlyManagement',
];

/**
 * Declares which roles may call a handler (or every handler in a controller). Enforced once,
 * globally, by `RoleGuard` (T018) — no per-endpoint duplicate authorization logic (FR-006).
 * Handlers with no `@Roles()` are not role-restricted by this guard.
 */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
