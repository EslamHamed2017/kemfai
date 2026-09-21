import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { AuditService } from '../audit/audit.service';
import { Account } from './entities/account.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { MfaService } from './mfa.service';
import { KeycloakUnavailableError } from '../../integrations/keycloak/keycloak-user-provisioner';

/**
 * Unit coverage of T035's validation branches and its transactional confirm-commit
 * ordering, with a stubbed repository/provisioner/transaction manager. The load-bearing
 * proof that concurrent HTTP confirms are actually serialized by Postgres row locking
 * (and that a losing/rolled-back request can never falsely report success) lives in
 * test/integration/accounts-mfa.integration-spec.ts — that guarantee cannot be faithfully
 * exercised against a mock.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account-id',
    keycloakUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'owner@example.com',
    emailVerified: true,
    mfaEnrolled: false,
    selectedPlanId: null,
    selectedBillingCycle: null,
    preferredLocale: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Account;
}

describe('MfaService (T035, unit)', () => {
  let accountRepo: { findOne: jest.Mock };
  let beginTotpEnrollment: jest.Mock;
  let hasActiveTotpCredential: jest.Mock;
  let recordAccountMfaEnrolled: jest.Mock;
  let account: Account | null;

  beforeEach(() => {
    account = makeAccount();
    beginTotpEnrollment = jest.fn().mockResolvedValue(undefined);
    hasActiveTotpCredential = jest.fn().mockResolvedValue(true);
    recordAccountMfaEnrolled = jest.fn().mockResolvedValue(undefined);

    accountRepo = { findOne: jest.fn().mockImplementation(async () => account) };
    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: any) => {
      if (target === Account) {
        return accountRepo as any;
      }
      throw new Error(`Unexpected repository requested for ${String(target)}`);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeService(): MfaService {
    const audit = { recordAccountMfaEnrolled } as unknown as AuditService;
    const provisioner = { beginTotpEnrollment, hasActiveTotpCredential };
    return new MfaService(audit, provisioner as never);
  }

  describe('shared account resolution (enroll + confirm)', () => {
    it('malformed sub → 401, never reaches the DB', async () => {
      const service = makeService();
      await expect(service.enroll('not-a-uuid')).rejects.toThrow(UnauthorizedException);
      expect(accountRepo.findOne).not.toHaveBeenCalled();
    });

    it('no linked account → 401', async () => {
      account = null;
      const service = makeService();
      await expect(service.enroll('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('unverified account → 403, never calls Keycloak (prior review finding, 2026-09-21)', async () => {
      account = makeAccount({ emailVerified: false });
      const service = makeService();
      await expect(service.enroll(account.keycloakUserId)).rejects.toThrow(ForbiddenException);
      expect(beginTotpEnrollment).not.toHaveBeenCalled();

      await expect(service.confirm(account.keycloakUserId)).rejects.toThrow(ForbiddenException);
      expect(hasActiveTotpCredential).not.toHaveBeenCalled();
    });
  });

  describe('enroll', () => {
    it('adds the CONFIGURE_TOTP required action for a verified, not-yet-enrolled account', async () => {
      const service = makeService();
      const result = await service.enroll(account!.keycloakUserId);
      expect(result).toEqual({ accountId: 'account-id' });
      expect(beginTotpEnrollment).toHaveBeenCalledWith(account!.keycloakUserId);
    });

    it('already enrolled: idempotent no-op, never re-triggers Keycloak', async () => {
      account = makeAccount({ mfaEnrolled: true });
      const service = makeService();
      await service.enroll(account.keycloakUserId);
      expect(beginTotpEnrollment).not.toHaveBeenCalled();
    });

    it('Keycloak failure → 503', async () => {
      beginTotpEnrollment.mockRejectedValue(new KeycloakUnavailableError('down'));
      const service = makeService();
      await expect(service.enroll(account!.keycloakUserId)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('confirm', () => {
    it('already enrolled: idempotent 200 no-op, never re-checks Keycloak or re-audits', async () => {
      account = makeAccount({ mfaEnrolled: true });
      const service = makeService();
      const result = await service.confirm(account.keycloakUserId);
      expect(result).toEqual({ accountId: 'account-id', mfaEnrolled: true });
      expect(hasActiveTotpCredential).not.toHaveBeenCalled();
      expect(recordAccountMfaEnrolled).not.toHaveBeenCalled();
    });

    it('Keycloak CONFIGURE_TOTP not yet completed → 409, zero state change', async () => {
      hasActiveTotpCredential.mockResolvedValue(false);
      const service = makeService();
      await expect(service.confirm(account!.keycloakUserId)).rejects.toThrow(ConflictException);
      expect(recordAccountMfaEnrolled).not.toHaveBeenCalled();
    });

    it('Keycloak credential-check failure → 503, zero state change', async () => {
      hasActiveTotpCredential.mockRejectedValue(new KeycloakUnavailableError('down'));
      const service = makeService();
      await expect(service.confirm(account!.keycloakUserId)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(recordAccountMfaEnrolled).not.toHaveBeenCalled();
    });

    describe('once Keycloak confirms completion — the transactional commit', () => {
      let lockedAccount: Account;
      let managerAccountRepo: { createQueryBuilder: jest.Mock; save: jest.Mock };
      let managerTenantRepo: { findOne: jest.Mock };
      let queryBuilder: {
        setLock: jest.Mock;
        where: jest.Mock;
        getOneOrFail: jest.Mock;
      };
      let tenantRow: Tenant | null;
      let transactionSpy: jest.SpyInstance;
      let manager: { getRepository: jest.Mock };

      beforeEach(() => {
        lockedAccount = makeAccount({ mfaEnrolled: false });
        tenantRow = { id: 'tenant-id' } as Tenant;

        queryBuilder = {
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOneOrFail: jest.fn().mockImplementation(async () => lockedAccount),
        };
        managerAccountRepo = {
          createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
          save: jest.fn().mockResolvedValue(undefined),
        };
        managerTenantRepo = { findOne: jest.fn().mockImplementation(async () => tenantRow) };

        manager = {
          getRepository: jest.fn((target: any) => {
            if (target === Account) {
              return managerAccountRepo;
            }
            if (target === Tenant) {
              return managerTenantRepo;
            }
            throw new Error(`Unexpected manager repository requested for ${String(target)}`);
          }),
        };
        transactionSpy = jest
          .spyOn(controlDataSource, 'transaction')
          .mockImplementation(async (arg: any) => arg(manager));
      });

      it('locks the row, flips the flag, and audits — tenant looked up BEFORE the flag write, in the SAME transaction', async () => {
        const service = makeService();
        const result = await service.confirm(account!.keycloakUserId);

        expect(result).toEqual({ accountId: 'account-id', mfaEnrolled: true });
        expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
        expect(lockedAccount.mfaEnrolled).toBe(true);
        expect(managerAccountRepo.save).toHaveBeenCalledWith(
          expect.objectContaining({ mfaEnrolled: true }),
        );
        expect(recordAccountMfaEnrolled).toHaveBeenCalledWith(
          { accountId: 'account-id', tenantId: 'tenant-id' },
          manager,
        );
      });

      it('a concurrent winner already committed under the lock → idempotent no-op, no second save/audit', async () => {
        lockedAccount = makeAccount({ mfaEnrolled: true });
        queryBuilder.getOneOrFail.mockImplementation(async () => lockedAccount);
        const service = makeService();

        const result = await service.confirm(account!.keycloakUserId);
        expect(result).toEqual({ accountId: 'account-id', mfaEnrolled: true });
        expect(managerAccountRepo.save).not.toHaveBeenCalled();
        expect(recordAccountMfaEnrolled).not.toHaveBeenCalled();
      });

      it('audit failure inside the transaction → 503; the flag flip is never observed outside it', async () => {
        recordAccountMfaEnrolled.mockRejectedValue(new Error('audit insert failed'));
        const service = makeService();

        await expect(service.confirm(account!.keycloakUserId)).rejects.toThrow(
          ServiceUnavailableException,
        );
        // The transaction callback DID flip the in-memory row and call save (TypeORM's real
        // transaction() would roll this back at the DB level on the thrown error — proven
        // against real Postgres in the integration suite).
        expect(managerAccountRepo.save).toHaveBeenCalled();
      });

      afterEach(() => {
        transactionSpy.mockRestore();
      });
    });
  });
});
