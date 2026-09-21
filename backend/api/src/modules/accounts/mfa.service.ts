import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { AuditService } from '../audit/audit.service';
import { Tenant } from '../tenants/entities/tenant.entity';
import { Account } from './entities/account.entity';
import {
  KEYCLOAK_USER_PROVISIONER,
  KeycloakUserProvisioner,
} from '../../integrations/keycloak/keycloak-user-provisioner';

export interface EnrollMfaResult {
  accountId: string;
}

export interface ConfirmMfaResult {
  accountId: string;
  mfaEnrolled: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MFA_ACCOUNT_NOT_VERIFIED_MESSAGE = 'Email must be verified before enrolling in MFA.';
export const MFA_TOTP_NOT_COMPLETE_MESSAGE =
  'TOTP setup has not been completed yet. Finish the Keycloak MFA setup, then confirm again.';
export const MFA_TEMPORARILY_UNAVAILABLE_MESSAGE =
  'MFA is temporarily unavailable. Please try again shortly.';

/**
 * T035 — `POST /accounts/mfa/enroll` and `POST /accounts/mfa/confirm` (FR-020, Acceptance
 * Scenario 1.4). Per research.md, MFA is Keycloak's native `CONFIGURE_TOTP` required action
 * end to end — KEMFAI never generates or verifies a TOTP secret/code itself; `confirm` only
 * ever trusts Keycloak's own credential state (`hasActiveTotpCredential`).
 *
 * Concurrency/failure-atomicity model (2026-09-21 review finding): a naive "conditional
 * UPDATE ... WHERE mfa_enrolled = false, then audit" sequence lets a SECOND concurrent
 * confirm request observe "0 rows affected" and report success even though the FIRST
 * request's audit write later fails and its state gets compensated back to false — a
 * request could then answer 200 while neither durable enrollment nor the mandatory
 * `account.mfa_enrolled` audit event actually exist. `confirm` instead:
 *
 *   1. Checks Keycloak's credential state OUTSIDE any lock (side-effect-free read; no harm
 *      in two concurrent requests both observing "complete").
 *   2. Opens ONE DB transaction and takes a `SELECT ... FOR UPDATE` row lock on the
 *      account — this fully serializes every concurrent confirm for the same account: a
 *      second request's transaction cannot even read account state until the first's
 *      commits or rolls back.
 *   3. Re-checks `mfaEnrolled` under the lock (idempotent no-op if a concurrent winner
 *      already committed it) and, only if still false, flips the flag AND appends the
 *      `account.mfa_enrolled` audit event through the SAME transaction manager.
 *
 * Because the flag flip and its audit event are one atomic transaction, there is no window
 * in which either can be durable without the other: a request only ever answers 200 once
 * BOTH have actually committed, and an audit failure rolls the flag back automatically
 * (Postgres ROLLBACK) with no separate, race-prone compensation step to fall out of sync.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly audit: AuditService,
    @Inject(KEYCLOAK_USER_PROVISIONER)
    private readonly keycloakUsers: KeycloakUserProvisioner,
  ) {}

  async enroll(keycloakUserId: string): Promise<EnrollMfaResult> {
    const account = await this.requireVerifiedAccount(keycloakUserId);

    if (!account.mfaEnrolled) {
      try {
        await this.keycloakUsers.beginTotpEnrollment(account.keycloakUserId);
      } catch (error) {
        this.logger.error(
          `Keycloak CONFIGURE_TOTP required-action failed for account ${account.id}`,
          error as Error,
        );
        throw new ServiceUnavailableException(MFA_TEMPORARILY_UNAVAILABLE_MESSAGE);
      }
    }

    return { accountId: account.id };
  }

  async confirm(keycloakUserId: string): Promise<ConfirmMfaResult> {
    const account = await this.requireVerifiedAccount(keycloakUserId);
    if (account.mfaEnrolled) {
      return { accountId: account.id, mfaEnrolled: true };
    }

    let completed: boolean;
    try {
      completed = await this.keycloakUsers.hasActiveTotpCredential(account.keycloakUserId);
    } catch (error) {
      this.logger.error(
        `Keycloak TOTP credential check failed for account ${account.id}`,
        error as Error,
      );
      throw new ServiceUnavailableException(MFA_TEMPORARILY_UNAVAILABLE_MESSAGE);
    }
    if (!completed) {
      throw new ConflictException(MFA_TOTP_NOT_COMPLETE_MESSAGE);
    }

    try {
      await controlDataSource.transaction(async (manager) => {
        const accountRepo = manager.getRepository(Account);
        const locked = await accountRepo
          .createQueryBuilder('account')
          .setLock('pessimistic_write')
          .where('account.id = :id', { id: account.id })
          .getOneOrFail();

        if (locked.mfaEnrolled) {
          return; // a concurrent winner already committed this — idempotent no-op.
        }

        const tenant = await manager
          .getRepository(Tenant)
          .findOne({ where: { accountId: locked.id } });

        locked.mfaEnrolled = true;
        await accountRepo.save(locked);

        await this.audit.recordAccountMfaEnrolled(
          { accountId: locked.id, tenantId: tenant?.id ?? null },
          manager,
        );
      });
    } catch (error) {
      this.logger.error(
        `MFA confirmation failed to commit for account ${account.id} — flag and audit rolled back together`,
        error as Error,
      );
      throw new ServiceUnavailableException(MFA_TEMPORARILY_UNAVAILABLE_MESSAGE);
    }

    return { accountId: account.id, mfaEnrolled: true };
  }

  private async requireVerifiedAccount(keycloakUserId: string): Promise<Account> {
    // Keycloak always mints `sub` as a UUID, but a forged/malformed token must not reach
    // the uuid-typed `keycloak_user_id` column as a raw query param (same guard as
    // EntitlementsService/TenantContextResolver).
    if (!UUID_PATTERN.test(keycloakUserId)) {
      throw new UnauthorizedException('No account is linked to the authenticated user');
    }
    const account = await controlDataSource
      .getRepository(Account)
      .findOne({ where: { keycloakUserId } });
    if (!account) {
      throw new UnauthorizedException('No account is linked to the authenticated user');
    }
    if (!account.emailVerified) {
      throw new ForbiddenException(MFA_ACCOUNT_NOT_VERIFIED_MESSAGE);
    }
    return account;
  }
}
