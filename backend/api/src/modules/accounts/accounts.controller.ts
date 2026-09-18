import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { RequireFeatureFlag } from '../../common/decorators/feature-flag.decorator';
import { AccountsService, SignupResult } from './accounts.service';
import { SignupRequestDto } from './dto/signup.request.dto';

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
  @HttpCode(HttpStatus.CREATED)
  signup(@Body() dto: SignupRequestDto): Promise<SignupResult> {
    return this.accounts.signup(dto);
  }
}
