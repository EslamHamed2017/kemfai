import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * T033 — email-verification token primitives (FR-019/FR-021).
 *
 * The link token is 256 bits of CSPRNG entropy in base64url — opaque, carrying no
 * account data — and only its SHA-256 hex digest is ever persisted. This is deliberately
 * NOT a JWT/OTP scheme: the ratified contract (`POST /accounts/verify-email`, 200/410)
 * needs a bearer secret the BFF can judge single-use, latest-wins, with an expiry —
 * plain random + hash + registry lookup satisfies that with zero custom cryptography
 * beyond `randomBytes`/`sha256` (research.md §2's "no hand-rolled token/OTP logic").
 */

/** Default link lifetime: 12 hours, mirroring Keycloak's default Admin-REST action-token lifespan. */
export const DEFAULT_TOKEN_TTL_MINUTES = 720;

export function resolveTokenTtlMinutes(): number {
  const raw = Number(process.env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES ?? DEFAULT_TOKEN_TTL_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TOKEN_TTL_MINUTES;
  }
  return raw;
}

export interface IssuedEmailVerificationToken {
  /** Raw bearer token — goes into the emailed link and the email job payload, never the DB. */
  token: string;
  /** Events.md job-id component for the email.send_verification queue (`account_id` + version). */
  tokenVersion: string;
  expiresAt: Date;
}

export function mintVerificationToken(now: Date = new Date()): IssuedEmailVerificationToken {
  const tokenVersion = randomUUID();
  return {
    token: randomBytes(32).toString('base64url'),
    tokenVersion,
    expiresAt: new Date(now.getTime() + resolveTokenTtlMinutes() * 60_000),
  };
}

export function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
