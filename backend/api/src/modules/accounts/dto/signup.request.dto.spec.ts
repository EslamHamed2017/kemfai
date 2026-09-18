import { validateSync } from 'class-validator';
import { BillingCycle } from '../entities/account.entity';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, SignupRequestDto } from './signup.request.dto';

/**
 * T032 review finding (2026-09-19 00:57): a missing or null password previously reached
 * `password.length` in service code and produced an uncontrolled 500. The DTO must reject
 * every ill-formed body at the runtime boundary with 422 — these tests validate the DTO
 * through class-validator itself (the exact engine the global ValidationPipe runs).
 */
function validate(partial: Partial<SignupRequestDto>): string[] {
  const dto = Object.assign(new SignupRequestDto(), partial);
  return validateSync(dto).flatMap((error) =>
    error.constraints ? Object.values(error.constraints) : [],
  );
}

const VALID: SignupRequestDto = {
  email: 'owner@example.com',
  password: 'a-very-strong-password',
  planId: '11111111-1111-4111-8111-111111111111',
  billingCycle: BillingCycle.MONTHLY,
  acceptedTerms: true,
};

describe('SignupRequestDto (T032, runtime validation)', () => {
  it('accepts a fully well-formed body', () => {
    expect(validate(VALID)).toEqual([]);
  });

  it.each([
    ['missing password', { password: undefined }],
    ['null password', { password: null as unknown as string }],
    ['non-string password', { password: 12345678901 as unknown as string }],
    ['too-short password', { password: 'short' }],
    ['exactly-below-minimum password', { password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1) }],
    [`over-maximum password`, { password: 'a'.repeat(PASSWORD_MAX_LENGTH + 1) }],
  ])('rejects a %s with a validation error (never reaches service code)', (_label, override) => {
    const errors = validate({ ...VALID, ...override });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((message) => message.toLowerCase().includes('password'))).toBe(true);
  });

  it('accepts a password of exactly the documented minimum length', () => {
    expect(validate({ ...VALID, password: 'a'.repeat(PASSWORD_MIN_LENGTH) })).toEqual([]);
  });

  it.each([
    ['missing email', { email: undefined }],
    ['malformed email', { email: 'not-an-email' }],
    ['empty email', { email: '' }],
  ])('rejects a %s', (_label, override) => {
    const errors = validate({ ...VALID, ...override });
    expect(errors.some((message) => message.toLowerCase().includes('email'))).toBe(true);
  });

  it.each([
    ['missing planId', { planId: undefined }],
    ['non-uuid planId', { planId: 'not-a-uuid' }],
    ['wrong billingCycle value', { billingCycle: 'quarterly' as unknown as BillingCycle }],
    ['missing billingCycle', { billingCycle: undefined }],
  ])('rejects a %s', (_label, override) => {
    expect(validate({ ...VALID, ...override }).length).toBeGreaterThan(0);
  });

  it.each([
    ['missing acceptedTerms', { acceptedTerms: undefined }],
    ['false acceptedTerms', { acceptedTerms: false }],
    ['non-boolean acceptedTerms', { acceptedTerms: 'true' as unknown as boolean }],
  ])('rejects %s — the legal terms must be accepted (Scenario 1.2)', (_label, override) => {
    const errors = validate({ ...VALID, ...override });
    expect(errors.some((message) => message.includes('acceptedTerms'))).toBe(true);
  });
});
