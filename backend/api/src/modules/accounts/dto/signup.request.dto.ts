import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { BillingCycle } from '../entities/account.entity';

/**
 * FR-018's documented minimum password standard (see also SignupRequest in
 * contracts/openapi.yaml, which carries the same minLength/maxLength): a password MUST be
 * a string of at least 10 and at most 128 characters. Length is the gate — no composition
 * rules — mirroring NIST SP 800-63B guidance. Validated at runtime by the global
 * ValidationPipe (422), never only by TypeScript types.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

@ValidatorConstraint({ name: 'isAcceptedTermsTrue', async: false })
class AcceptedTermsTrueConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return value === true;
  }

  defaultMessage(): string {
    return 'acceptedTerms must be true — the legal terms must be accepted to sign up';
  }
}

/**
 * Request body of `POST /accounts/signup` (contracts/openapi.yaml "SignupRequest",
 * FR-017/FR-018). Runtime-validated by class-validator via the global ValidationPipe —
 * the 422 path is what the contract's "Malformed email or weak password" response means,
 * so a missing/null/ill-typed field must never reach service code (review finding,
 * 2026-09-19: a null password previously reached `password.length` as an uncontrolled 500).
 */
export class SignupRequestDto {
  @IsEmail({}, { message: 'email must be a well-formed email address' })
  email!: string;

  @IsString({ message: 'password must be a string' })
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  })
  @MaxLength(PASSWORD_MAX_LENGTH, {
    message: `password must be at most ${PASSWORD_MAX_LENGTH} characters`,
  })
  password!: string;

  @IsUUID('4', { message: 'planId must be a UUID' })
  planId!: string;

  @IsIn([BillingCycle.MONTHLY, BillingCycle.ANNUAL], {
    message: 'billingCycle must be one of: monthly, annual',
  })
  billingCycle!: BillingCycle;

  @IsBoolean({ message: 'acceptedTerms must be a boolean' })
  @Validate(AcceptedTermsTrueConstraint)
  acceptedTerms!: boolean;
}
