import { IsIn, IsString } from 'class-validator';

/**
 * T104 — request body of `PATCH /accounts/me/locale` (contracts/openapi.yaml,
 * LocaleUpdateRequest). Any value other than the two supported locales is the
 * contract-wide 422 via the global ValidationPipe (APP_PIPE), never a 500.
 */
export class LocaleUpdateRequestDto {
  @IsString()
  @IsIn(['en', 'ar'])
  locale!: 'en' | 'ar';
}
