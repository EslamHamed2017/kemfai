import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { RequireFeatureFlag } from '../../common/decorators/feature-flag.decorator';
import { AuthenticatedRequest } from '../../common/guards/bearer-auth.guard';
import { ACCOUNTS_FEATURE_KEY } from './accounts.controller';
import { ConfirmMfaResult, EnrollMfaResult, MfaService } from './mfa.service';

/**
 * T035 — MFA (TOTP) enrollment for the authenticated, verified account (FR-020, Acceptance
 * Scenario 1.4). Authentication is applied globally (BearerAuthGuard via APP_GUARD, T017) —
 * no per-route @UseGuards needed. Gated by the same `module.accounts` feature flag as the
 * rest of the accounts surface (Constitution Principle VI).
 */
@Controller('accounts/mfa')
@RequireFeatureFlag(ACCOUNTS_FEATURE_KEY)
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  /**
   * Begins MFA enrollment by adding Keycloak's native `CONFIGURE_TOTP` required action —
   * the customer completes the actual TOTP setup on Keycloak's own hosted flow
   * (research.md: KEMFAI never re-implements TOTP secret generation).
   */
  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  enroll(@Req() req: AuthenticatedRequest): Promise<EnrollMfaResult> {
    return this.mfa.enroll(req.auth.keycloakUserId);
  }

  /**
   * Confirms MFA enrollment is active. Never trusts a client-supplied code — only
   * Keycloak's own credential state — and is failure-atomic: `Account.mfaEnrolled` and the
   * mandatory `account.mfa_enrolled` audit event commit or roll back together (mfa.service.ts).
   */
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@Req() req: AuthenticatedRequest): Promise<ConfirmMfaResult> {
    return this.mfa.confirm(req.auth.keycloakUserId);
  }
}
