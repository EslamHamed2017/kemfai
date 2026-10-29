/**
 * T037 — classifies `POST /accounts/signup` failures by status AND payload (arbiter
 * resolution, 2026-09-23): a bare 422 is never mapped straight to "plan unavailable" — the
 * NestJS ValidationPipe `message` (a string for a single-string exception, or an array of
 * field-prefixed strings for class-validator failures; see contracts/openapi.yaml
 * NestErrorResponse) is inspected to pick the specific, actionable error.
 */
export type SignupErrorKind =
  | 'duplicateEmail'
  | 'malformedEmail'
  | 'weakPassword'
  | 'planUnavailable'
  | 'rateLimited'
  | 'validation'
  | 'unexpected';

/**
 * Mirrors `PLAN_NO_LONGER_AVAILABLE_MESSAGE` in
 * backend/api/src/modules/accounts/accounts.service.ts exactly — the frontend and backend
 * are separate deployables with no shared package, so this literal must be kept in sync by
 * hand (covered by the classification tests below).
 */
export const PLAN_NO_LONGER_AVAILABLE_MESSAGE =
  'The selected plan is no longer available. Please choose a plan again.';

function normalizeMessage(message: unknown): string {
  if (Array.isArray(message)) {
    return message.join(' ');
  }
  return typeof message === 'string' ? message : '';
}

export function classifySignupError(status: number, message: unknown): SignupErrorKind {
  if (status === 409) {
    return 'duplicateEmail';
  }
  if (status === 429) {
    return 'rateLimited';
  }
  if (status !== 422) {
    return 'unexpected';
  }

  const text = normalizeMessage(message);
  if (text === PLAN_NO_LONGER_AVAILABLE_MESSAGE) {
    return 'planUnavailable';
  }
  if (text.includes('email')) {
    return 'malformedEmail';
  }
  if (text.includes('password')) {
    return 'weakPassword';
  }
  if (text.includes('planId') || text.includes('billingCycle')) {
    return 'planUnavailable';
  }
  return 'validation';
}
