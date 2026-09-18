import { IsEmail } from 'class-validator';

/**
 * Request body of `POST /accounts/resend-verification` (contracts/openapi.yaml,
 * FR-021): just the email address. A malformed email is the contract-wide 422,
 * stopped by the global ValidationPipe before service code; a well-formed email
 * ALWAYS yields 202 with an empty body whether the account is unknown, unverified,
 * or already verified — the response must carry zero account-existence information.
 */
export class ResendVerificationRequestDto {
  @IsEmail({}, { message: 'email must be a well-formed email address' })
  email!: string;
}
