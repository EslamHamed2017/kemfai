import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import controlDataSource from '../../database/data-source';
import { AuditService } from '../audit/audit.service';
import { Plan } from '../entitlements/entities/plan.entity';
import { Account } from './entities/account.entity';
import { SignupRequestDto } from './dto/signup.request.dto';
import {
  CreateKeycloakUserInput,
  KEYCLOAK_USER_PROVISIONER,
  KeycloakUserProvisioner,
} from '../../integrations/keycloak/keycloak-user-provisioner';
import {
  QUEUE_EMAIL_SEND_VERIFICATION,
  emailVerificationJobId,
} from '../../common/queues/queue-names';

export interface SignupResult {
  accountId: string;
}

/** Postgres unique-violation code — the DB-level anchor of signup idempotency (FR-023-style). */
const PG_UNIQUE_VIOLATION = '23505';

export const PLAN_NO_LONGER_AVAILABLE_MESSAGE =
  'The selected plan is no longer available. Please choose a plan again.';
/** Scenario 1.6: generic message only — never reveals more than the documented 409 itself. */
export const DUPLICATE_EMAIL_GENERIC_MESSAGE =
  'This email cannot be used to create a new account. If it is yours, sign in or reset your password instead.';
export const SIGNUP_TEMPORARILY_UNAVAILABLE_MESSAGE =
  'Signup is temporarily unavailable. Please try again shortly.';

/**
 * T032 — `POST /accounts/signup` (FR-016–FR-019, Acceptance Scenarios 1.1/1.2/1.6, Edge
 * Cases: stale plan selection, unverified duplicate, concurrency).
 *
 * Failure-atomicity model (prior review finding, 2026-09-19 00:37): the signup saga runs
 * as ordered steps with explicit compensation, not as loose irreversible side effects:
 *
 *   1. Re-validate the referenced plan is STILL published — for BOTH the new-account path
 *      and the unverified-duplicate/resend path — before any side effect (422 prompting
 *      re-selection otherwise; Edge Cases "stale plan data").
 *   2. Insert the Account row FIRST. The unique index on email is the idempotency anchor:
 *      concurrent same-email requests collapse here exactly once, so exactly one request
 *      ever proceeds to Keycloak user creation — no orphan identities, no second row
 *      (T028). A loser of the insert race re-sends verification for the existing
 *      unverified account, or returns the generic 409 for a verified one.
 *   3. Create the Keycloak user with the pre-allocated Account.keycloakUserId. On failure:
 *      compensate by deleting the just-inserted row and answer a controlled 503 — no
 *      orphan Keycloak identity, no half-created state.
 *   4. Append the `account.created` audit event (AuditService, T019) BEFORE any success
 *      signal. If the append-only write fails, compensate step 3 AND the row (best
 *      effort) so a committed account can never lack its audit trail.
 *   5. Enqueue email.send_verification keyed by account_id + fresh token version
 *      (events.md). Per events.md this job "does not block signup response": an enqueue
 *      failure is logged for ops and recovered via resend-verification (T034) — it never
 *      fails the request and never happens before steps 1–4 fully succeeded.
 */
@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_EMAIL_SEND_VERIFICATION)
    private readonly emailVerificationQueue: Queue,
    @Inject(KEYCLOAK_USER_PROVISIONER)
    private readonly keycloakUsers: KeycloakUserProvisioner,
  ) {}

  async signup(input: SignupRequestDto): Promise<SignupResult> {
    const email = input.email.trim().toLowerCase();

    // Step 1 — plan re-validation precedes EVERY path (new account and duplicate/resend
    // alike): an unverified duplicate must be prompted to re-select, never silently
    // proceed with stale plan data (prior review finding, 2026-09-19 00:37).
    const planRepo = controlDataSource.getRepository(Plan);
    const plan = await planRepo.findOne({ where: { id: input.planId, published: true } });
    if (!plan) {
      throw new UnprocessableEntityException(PLAN_NO_LONGER_AVAILABLE_MESSAGE);
    }

    // Step 2 — the Account row is the idempotency anchor.
    const accountRepo = controlDataSource.getRepository(Account);
    let account: Account;
    try {
      account = await accountRepo.save(
        accountRepo.create({
          email,
          keycloakUserId: randomUUID(),
          emailVerified: false,
          mfaEnrolled: false,
          selectedPlanId: input.planId,
          selectedBillingCycle: input.billingCycle,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        return this.handleExistingAccount(email, input);
      }
      throw error;
    }

    // Step 3 — Keycloak user creation; compensated on failure so neither side orphans.
    const createInput: CreateKeycloakUserInput = {
      id: account.keycloakUserId,
      email,
      password: input.password,
      requiredActions: ['VERIFY_EMAIL'],
    };
    try {
      await this.keycloakUsers.createUser(createInput);
    } catch (error) {
      this.logger.error(
        `Keycloak user creation failed for account ${account.id}; compensating the account row`,
        error as Error,
      );
      await this.bestEffortDeleteAccountRow(account.id);
      throw new ServiceUnavailableException(SIGNUP_TEMPORARILY_UNAVAILABLE_MESSAGE);
    }

    // Step 4 — audit BEFORE any success signal; compensate fully if it cannot be written.
    try {
      await this.audit.recordAccountCreated({
        accountId: account.id,
        planId: input.planId,
        billingCycle: input.billingCycle,
      });
    } catch (error) {
      this.logger.error(
        `account.created audit write failed for account ${account.id}; compensating signup`,
        error as Error,
      );
      await this.compensateSignup(account);
      throw new ServiceUnavailableException(SIGNUP_TEMPORARILY_UNAVAILABLE_MESSAGE);
    }

    // Step 5 — verification email; retried with backoff and never blocking the response
    // (contracts/events.md email.send_verification row).
    await this.enqueueVerificationEmail(account.id, email);

    return { accountId: account.id };
  }

  /**
   * The email already has an Account row — Edge Cases: never a second row. A VERIFIED
   * account gets the generic Scenario 1.6 rejection; an UNVERIFIED one gets its
   * verification re-sent, with the latest submitted plan/cycle choice carried onto the
   * account (FR-017: the choice that travels is the visitor's current selection).
   */
  private async handleExistingAccount(
    email: string,
    input: SignupRequestDto,
  ): Promise<SignupResult> {
    const accountRepo = controlDataSource.getRepository(Account);
    const existing = await accountRepo.findOne({ where: { email } });
    if (!existing) {
      // The conflicting row vanished between the unique violation and this read — treat as
      // transient rather than surfacing a raw 500.
      throw new ServiceUnavailableException(SIGNUP_TEMPORARILY_UNAVAILABLE_MESSAGE);
    }
    if (existing.emailVerified) {
      throw new ConflictException(DUPLICATE_EMAIL_GENERIC_MESSAGE);
    }

    if (
      existing.selectedPlanId !== input.planId ||
      existing.selectedBillingCycle !== input.billingCycle
    ) {
      await accountRepo.update(existing.id, {
        selectedPlanId: input.planId,
        selectedBillingCycle: input.billingCycle,
      });
    }

    await this.enqueueVerificationEmail(existing.id, existing.email);
    return { accountId: existing.id };
  }

  private async enqueueVerificationEmail(accountId: string, email: string): Promise<void> {
    const tokenVersion = randomUUID();
    try {
      await this.emailVerificationQueue.add(
        'send',
        { accountId, email, tokenVersion },
        { jobId: emailVerificationJobId(accountId, tokenVersion) },
      );
    } catch (error) {
      this.logger.error(
        `email.send_verification enqueue failed for account ${accountId} — recoverable via resend-verification (T034)`,
        error as Error,
      );
    }
  }

  /** Compensation: undo Keycloak user creation, then the account row. Best effort, logged. */
  private async compensateSignup(account: Account): Promise<void> {
    try {
      await this.keycloakUsers.deleteUser(account.keycloakUserId);
    } catch (error) {
      this.logger.error(
        `Keycloak compensation delete failed for user ${account.keycloakUserId} (account ${account.id}) — manual cleanup required`,
        error as Error,
      );
    }
    await this.bestEffortDeleteAccountRow(account.id);
  }

  private async bestEffortDeleteAccountRow(accountId: string): Promise<void> {
    try {
      await controlDataSource.getRepository(Account).delete({ id: accountId });
    } catch (error) {
      this.logger.error(
        `Account-row compensation delete failed for account ${accountId} — manual cleanup required`,
        error as Error,
      );
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === PG_UNIQUE_VIOLATION;
}
