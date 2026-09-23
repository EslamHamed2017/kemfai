import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

function base64url(value: Buffer): string {
  return value.toString('base64url');
}

export function randomOpaque(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomOpaque(64);
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function constantTimeEqual(left?: string | null, right?: string | null): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
