import {
  classifySignupError,
  PLAN_NO_LONGER_AVAILABLE_MESSAGE,
} from '../../src/app/(auth)/signup/signup-error';

describe('classifySignupError (T037 — arbiter-resolved signup error classification)', () => {
  it('classifies 409 as duplicateEmail regardless of message content', () => {
    expect(classifySignupError(409, 'anything')).toBe('duplicateEmail');
    expect(classifySignupError(409, undefined)).toBe('duplicateEmail');
  });

  it('classifies a 422 whose message contains "email" as malformedEmail', () => {
    expect(classifySignupError(422, 'email must be a well-formed email address')).toBe(
      'malformedEmail',
    );
    expect(classifySignupError(422, ['email must be a well-formed email address'])).toBe(
      'malformedEmail',
    );
  });

  it('classifies a 422 whose message contains "password" as weakPassword', () => {
    expect(classifySignupError(422, 'password must be at least 10 characters')).toBe(
      'weakPassword',
    );
    expect(classifySignupError(422, ['password must be at most 128 characters'])).toBe(
      'weakPassword',
    );
  });

  it('classifies a 422 with the exact stale-plan backend message as planUnavailable', () => {
    expect(classifySignupError(422, PLAN_NO_LONGER_AVAILABLE_MESSAGE)).toBe('planUnavailable');
  });

  it('classifies a 422 whose message contains planId/billingCycle as planUnavailable', () => {
    expect(classifySignupError(422, 'planId must be a UUID')).toBe('planUnavailable');
    expect(classifySignupError(422, ['billingCycle must be one of: monthly, annual'])).toBe(
      'planUnavailable',
    );
  });

  it('classifies any unmatched 422 as the generic validation error, never planUnavailable', () => {
    expect(classifySignupError(422, 'acceptedTerms must be true — the legal terms must be accepted to sign up')).toBe(
      'validation',
    );
    expect(classifySignupError(422, undefined)).toBe('validation');
  });

  it('classifies any other status as unexpected', () => {
    expect(classifySignupError(503, 'Signup is temporarily unavailable')).toBe('unexpected');
    expect(classifySignupError(500, undefined)).toBe('unexpected');
  });
});
