import {
  ConflictException,
  HttpException,
  HttpStatus,
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
import { Account, Locale as AccountLocaleValue } from './entities/account.entity';
import { EmailVerificationToken } from './entities/email-verification-token.entity';
import { SignupRequestDto } from './dto/signup.request.dto';
import { hashVerificationToken, mintVerificationToken } from './tokens/email-verification-token';
import {
  CreateKeycloakUserInput,
  KEYCLOAK_USER_PROVISIONER,
  KeycloakUserProvisioner,
} from '../../integrations/keycloak/keycloak-user-provisioner';
import {
  QUEUE_EMAIL_SEND_VERIFICATION,
  QUEUE_TENANT_PROVISION,
  emailVerificationJobId,
  tenantProvisionJobId,
} from '../../common/queues/queue-names';

export interface SignupResult {
  accountId: string;
}

export interface VerifyEmailResult {
  accountId: string;
}

/** T104 — read shape of `GET /accounts/me/locale` (null until the account chose one). */
export interface PreferredLocaleResult {
  locale: AccountLocaleValue | null;
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
export const VERIFICATION_TEMPORARILY_UNAVAILABLE_MESSAGE =
  'Email verification is temporarily unavailable. Please try again shortly.';

/** 410 reason codes + human messages (Edge Cases, FR-021; FR-012 actionable states for T038). */
export type VerificationGoneReason = 'invalid' | 'expired' | 'superseded' | 'used';

export const VERIFICATION_GONE_MESSAGES: Record<VerificationGoneReason, string> = {
  invalid: 'This verification link is not valid. Please request a new one.',
  expired: 'This verification link has expired. Please request a new one.',
  superseded:
    'A newer verification link has been issued for this account; only the most recent link can be used.',
  used: 'This verification link has already been used. If you still need to verify, request a new one.',
};

export function verificationGoneException(reason: VerificationGoneReason): HttpException {
  return new HttpException(
    { statusCode: HttpStatus.GONE, reason, message: VERIFICATION_GONE_MESSAGES[reason] },
    HttpStatus.GONE,
  );
}

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
    @InjectQueue(QUEUE_TENANT_PROVISION)
    private readonly tenantProvisionQueue: Queue,
    @Inject(KEYCLOAK_USER_PROVISIONER)
    private readonly keycloakUsers: KeycloakUserProvisioner,
  ) {}

  /**
   * T104 — `PATCH /accounts/me/locale` (FR-024). Persists the preference on the caller's
   * own Account row only. A validly-authenticated subject with no Account row (not a
   * real state in the signup flow) is a logged no-op 200 rather than an information-
   * leaking lookup error — the preference simply has nowhere to persist yet.
   */
  async setPreferredLocale(keycloakUserId: string, locale: AccountLocaleValue): Promise<void> {
    // T104 — persistence and its mandatory `account.locale_changed` audit event commit or
    // roll back TOGETHER (the T035 doctrine: a state flip and its audit trail are one
    // transaction). This also removes the audit-skip-on-retry hazard: if the audit write
    // fails, the preference write is rolled back too, so a retry re-attempts BOTH.
    await controlDataSource.transaction(async (manager) => {
      const accountRepo = manager.getRepository(Account);
      const account = await accountRepo.findOne({ where: { keycloakUserId } });
      if (!account) {
        this.logger.warn(
          `setPreferredLocale: no Account row for authenticated subject ${keycloakUserId}`,
        );
        return;
      }
      if (account.preferredLocale !== locale) {
        const fromLocale = account.preferredLocale;
        account.preferredLocale = locale;
        await accountRepo.save(account);
        await this.audit.recordAccountLocaleChanged(
          { accountId: account.id, fromLocale, toLocale: locale },
          manager,
        );
      }
    });
  }

  /** T104 read side — the authenticated session's persisted locale, null until chosen. */
  async getPreferredLocale(keycloakUserId: string): Promise<PreferredLocaleResult> {
    const accountRepo = controlDataSource.getRepository(Account);
    const account = await accountRepo.findOne({ where: { keycloakUserId } });
    return { locale: account?.preferredLocale ?? null };
  }

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
      email,
      password: input.password,
      requiredActions: ['VERIFY_EMAIL'],
    };
    try {
      account.keycloakUserId = await this.keycloakUsers.createUser(createInput);
    } catch (error) {
      this.logger.error(
        `Keycloak user creation failed for account ${account.id}; compensating the account row`,
        error as Error,
      );
      await this.bestEffortDeleteAccountRow(account.id);
      throw new ServiceUnavailableException(SIGNUP_TEMPORARILY_UNAVAILABLE_MESSAGE);
    }
    // Persist Keycloak's canonical ID before issuing a verification link. If persistence
    // fails, delete the actual remote user rather than the temporary local placeholder.
    try {
      await accountRepo.update(account.id, { keycloakUserId: account.keycloakUserId });
    } catch (error) {
      this.logger.error(
        `Keycloak identity persistence failed for account ${account.id}`,
        error as Error,
      );
      await this.compensateSignup(account);
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
   * T033 — `POST /accounts/verify-email` (FR-021/FR-022 trigger, Acceptance Scenario 1.3,
   * Edge Cases "link used twice / newer link issued").
   *
   * Saga ordering (T032's failure-atomicity discipline, adapted):
   *   1. Read-only validation with precise 410 reasons (unknown / used / expired /
   *      superseded / stale link for an already-verified account) — no writes, so a
   *      doomed request never touches Keycloak.
   *   2. Keycloak mirror (`markEmailVerified`, idempotent) BEFORE any local write: on
   *      failure a controlled 503 returns with the token untouched — the same link
   *      remains retryable. (A Keycloak user still carrying the VERIFY_EMAIL required
   *      action would be stranded on Keycloak's own verification screen even after the
   *      BFF verified them — the mirror is therefore a required step, not cosmetic.)
   *   3. Atomic decide+consume: one guarded UPDATE re-checks unconsumed/unexpired/
   *      is-latest-wins, so concurrent replays of the same link collapse to exactly
   *      one winner (loser → 410). "Latest" is proven by `issuance_sequence`, never by
   *      timestamp comparison.
   *   4. One-way account flag, guarded `WHERE email_verified = false`: a concurrent
   *      winner's flip makes this request a 200 no-op with NO second audit event and
   *      NO duplicate tenant.provision job (idempotency, FR-023 spirit).
   *   5. Audit BEFORE any success signal; on failure compensate the flag AND the token
   *      consumption (best effort) so a committed verified account can never lack its
   *      audit trail, and answer 503 — the same link stays retryable. The Keycloak
   *      mirror is deliberately NOT reverted: BFF-side gates read Account.email_verified,
   *      so a Keycloak-verified-but-BFF-unverified divergence grants nothing and
   *      self-heals on retry/resend.
   *   6. Enqueue `tenant.provision` keyed by the bare account_id (events.md) — BullMQ
   *      dedupes duplicate adds; an enqueue failure is logged for ops (recoverable via
   *      provisioning-retry, T045) and never fails the request.
   */
  async verifyEmail(token: string): Promise<VerifyEmailResult> {
    const tokenHash = hashVerificationToken(token);
    const tokenRepo = controlDataSource.getRepository(EmailVerificationToken);
    const accountRepo = controlDataSource.getRepository(Account);

    // Step 1 — read-only validation with precise reasons.
    const row = await tokenRepo.findOne({ where: { tokenHash } });
    if (!row) {
      throw verificationGoneException('invalid');
    }
    if (row.consumedAt) {
      throw verificationGoneException('used');
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw verificationGoneException('expired');
    }
    const latest = await tokenRepo.findOne({
      where: { accountId: row.accountId },
      order: { issuanceSequence: 'DESC' },
    });
    if (!latest || latest.id !== row.id) {
      throw verificationGoneException('superseded');
    }
    const account = await accountRepo.findOne({ where: { id: row.accountId } });
    if (!account) {
      // FK guarantees this cannot happen; treated as an invalid link, never a 500.
      throw verificationGoneException('invalid');
    }
    if (account.emailVerified) {
      // One-way state: a live link for an already-verified account is stale by definition.
      throw verificationGoneException('used');
    }

    // Step 2 — Keycloak mirror first; transient failure keeps the link retryable.
    try {
      await this.keycloakUsers.markEmailVerified(account.keycloakUserId);
    } catch (error) {
      this.logger.error(
        `Keycloak email-verification mirror failed for user ${account.keycloakUserId} (account ${account.id})`,
        error as Error,
      );
      throw new ServiceUnavailableException(VERIFICATION_TEMPORARILY_UNAVAILABLE_MESSAGE);
    }

    // Step 3 — atomic decide+consume (guards every step-1 condition again under race).
    const consumed = await controlDataSource.query(
      `UPDATE email_verification_token AS t
         SET consumed_at = now()
       WHERE t.token_hash = $1
         AND t.consumed_at IS NULL
         AND t.expires_at > now()
         AND NOT EXISTS (
           SELECT 1 FROM email_verification_token AS newer
           WHERE newer.account_id = t.account_id
             AND newer.issuance_sequence > t.issuance_sequence
         )
       RETURNING t.account_id`,
      [tokenHash],
    );
    if (consumed.length === 0) {
      // Lost the race: another request consumed this link, or a newer link appeared.
      throw verificationGoneException('used');
    }

    // Step 4 — one-way flag flip; 0 affected rows means a concurrent winner already did it.
    const flagResult = await accountRepo.update(
      { id: account.id, emailVerified: false },
      { emailVerified: true },
    );
    if ((flagResult.affected ?? 0) === 1) {
      // Step 5 — audit before any success signal; compensate on failure.
      try {
        await this.audit.recordAccountEmailVerified({ accountId: account.id });
      } catch (error) {
        this.logger.error(
          `account.email_verified audit write failed for account ${account.id}; compensating verification`,
          error as Error,
        );
        await this.bestEffortCompensateVerification(account.id, row.id);
        throw new ServiceUnavailableException(VERIFICATION_TEMPORARILY_UNAVAILABLE_MESSAGE);
      }

      // Step 6 — tenant provisioning; never blocks the response (events.md).
      try {
        await this.tenantProvisionQueue.add(
          'provision',
          { accountId: account.id },
          { jobId: tenantProvisionJobId(account.id) },
        );
      } catch (error) {
        this.logger.error(
          `tenant.provision enqueue failed for account ${account.id} — recoverable via provisioning-retry (T045)`,
          error as Error,
        );
      }
    }

    return { accountId: account.id };
  }

  /**
   * T034 — `POST /accounts/resend-verification` (FR-021, Acceptance Scenario 1.5).
   *
   * Deliberately silent: ALWAYS resolves (202 with an empty body at the HTTP layer)
   * whether the email is unknown, unverified, or already verified — the response is
   * the no-account-existence-leak contract itself, so there is no error path keyed to
   * account state and no observable difference (no extra writes, no jobs) between the
   * three outcomes beyond the one documented side effect: for a KNOWN UNVERIFIED
   * account, a fresh link is issued via `enqueueVerificationEmail`, whose new
   * globally-higher `issuance_sequence` is precisely what invalidates every earlier
   * link (latest-wins consumption, FR-021). A verified account gets nothing — its
   * links are stale by definition (one-way state) and re-issuing one would resurrect
   * a dead flow. Token-registry/enqueue failures stay non-fatal for the same reason
   * as in signup: the customer simply retries resend.
   */
  async resendVerification(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const account = await controlDataSource.getRepository(Account).findOne({
      where: { email: normalized },
    });
    if (!account || account.emailVerified) {
      return;
    }
    await this.enqueueVerificationEmail(account.id, account.email);
  }

  /** Compensation: undo the flag flip and the token consumption. Best effort, logged. */
  private async bestEffortCompensateVerification(
    accountId: string,
    tokenId: string,
  ): Promise<void> {
    try {
      await controlDataSource
        .getRepository(Account)
        .update({ id: accountId, emailVerified: true }, { emailVerified: false });
      await controlDataSource.query(
        `UPDATE email_verification_token SET consumed_at = NULL WHERE id = $1`,
        [tokenId],
      );
    } catch (error) {
      this.logger.error(
        `Verification compensation failed for account ${accountId} / token ${tokenId} — manual cleanup required`,
        error as Error,
      );
    }
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

  /**
   * Issues a fresh verification link (T033) and dispatches its email. Every issuance —
   * signup, the unverified-duplicate resend below, and resend-verification (T034) — goes
   * through here, which is what makes "a newer link supersedes every earlier one"
   * (FR-021) hold: each INSERT is a new globally-higher `issuance_sequence`, and
   * consumption honors only the account's max-sequence row.
   *
   * Failure semantics match the accepted T032 contract: a token-registry or enqueue
   * failure is logged for ops and NEVER fails signup — the response has already been
   * earned by steps 1–4, and the customer recovers via resend-verification (T034).
   */
  private async enqueueVerificationEmail(accountId: string, email: string): Promise<void> {
    const minted = mintVerificationToken();
    try {
      await controlDataSource.getRepository(EmailVerificationToken).insert({
        accountId,
        tokenHash: hashVerificationToken(minted.token),
        tokenVersion: minted.tokenVersion,
        expiresAt: minted.expiresAt,
      });
    } catch (error) {
      this.logger.error(
        `verification-token issuance failed for account ${accountId} — recoverable via resend-verification (T034); email dispatch skipped (no consumable link exists)`,
        error as Error,
      );
      return;
    }

    try {
      await this.emailVerificationQueue.add(
        'send',
        // `token` is the raw link bearer — the email worker's payload, never persisted.
        { accountId, email, tokenVersion: minted.tokenVersion, token: minted.token },
        { jobId: emailVerificationJobId(accountId, minted.tokenVersion) },
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
