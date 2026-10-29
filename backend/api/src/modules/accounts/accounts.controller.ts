import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { RequireFeatureFlag } from '../../common/decorators/feature-flag.decorator';
import { AuthenticatedRequest } from '../../common/guards/bearer-auth.guard';
import {
  AccountsService,
  PreferredLocaleResult,
  SignupResult,
  VerifyEmailResult,
} from './accounts.service';
import { Locale as AccountLocale } from './entities/account.entity';
import { LocaleUpdateRequestDto } from './dto/locale-update.request.dto';
import { SignupRequestDto } from './dto/signup.request.dto';
import { VerifyEmailRequestDto } from './dto/verify-email.request.dto';
import { ResendVerificationRequestDto } from './dto/resend-verification.request.dto';
import { PublicAccountRateLimit } from './public-accounts-rate-limit';

/**
 * The accounts surface of the onboarding shell (T032+). `module.accounts` is the
 * config-driven feature flag gating this incomplete module (Constitution Principle VI —
 * the FeatureFlag row ships disabled and is turned on by data, not a deploy; T099/T100).
 * Class-level so every accounts handler added by T033–T035 inherits the same gate.
 */
export const ACCOUNTS_FEATURE_KEY = 'module.accounts';

@Controller('accounts')
@RequireFeatureFlag(ACCOUNTS_FEATURE_KEY)
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  /**
   * Signup is genuinely public (FR-016/FR-017 — there is no identity yet): @Public()
   * exempts it from bearer AUTHENTICATION only. Module-completeness gating still applies —
   * FeatureFlagGuard no longer short-circuits @Public() routes (T032 review finding,
   * 2026-09-19: public ≠ complete).
   */
  @Public()
  @Post('signup')
  @PublicAccountRateLimit('signup')
  @HttpCode(HttpStatus.CREATED)
  signup(@Body() dto: SignupRequestDto): Promise<SignupResult> {
    return this.accounts.signup(dto);
  }

  /**
   * T033 — consumes the emailed verification link's bearer token (FR-021). Public like
   * signup: the caller is proving account ownership with the token itself, so there is
   * no bearer identity to authenticate yet. 200 verifies and triggers provisioning;
   * every invalid/expired/superseded/used token is a 410 (Edge Cases).
   */
  @Public()
  @Post('verify-email')
  @PublicAccountRateLimit('verify-email')
  @HttpCode(HttpStatus.OK)
  verifyEmail(@Body() dto: VerifyEmailRequestDto): Promise<VerifyEmailResult> {
    return this.accounts.verifyEmail(dto.token);
  }

  /**
   * T034 — request a fresh verification link (FR-021, Acceptance Scenario 1.5). Public
   * like verify-email: an unverified account cannot authenticate, which is exactly the
   * caller this endpoint exists for. ALWAYS 202 with an empty body whether the email is
   * unknown, unverified, or verified — zero account-existence information (contracts/
   * openapi.yaml). A malformed email is the contract-wide 422, stopped by the global
   * ValidationPipe before service code.
   */
  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  resendVerification(@Body() dto: ResendVerificationRequestDto): Promise<void> {
    return this.accounts.resendVerification(dto.email);
  }

  /**
   * T104 — persists the authenticated account's locale preference (FR-024, U2 remediation).
   * Identity comes exclusively from the verified bearer token's `sub` (req.auth) — a caller
   * can only ever change its own account. Body validation is the global ValidationPipe's
   * contract-wide 422 (LocaleUpdateRequestDto), so this handler sees only 'en' | 'ar'.
   * 200 with an empty body per contracts/openapi.yaml; unknown-account no-op is logged.
   */
  @Patch('me/locale')
  @HttpCode(HttpStatus.OK)
  setPreferredLocale(
    @Req() req: AuthenticatedRequest,
    @Body() dto: LocaleUpdateRequestDto,
  ): Promise<void> {
    return this.accounts.setPreferredLocale(req.auth.keycloakUserId, dto.locale as AccountLocale);
  }

  /**
   * T104 read side — the initial-locale resolution source for authenticated sessions
   * (next-intl prefers this value over browser detection once logged in). Same bearer
   * identity rules; `locale` is null until the account has expressed a preference.
   */
  @Get('me/locale')
  @HttpCode(HttpStatus.OK)
  getPreferredLocale(@Req() req: AuthenticatedRequest): Promise<PreferredLocaleResult> {
    return this.accounts.getPreferredLocale(req.auth.keycloakUserId);
  }
}
