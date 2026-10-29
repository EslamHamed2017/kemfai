import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

export type PublicAccountRateLimitScope = 'signup' | 'verify-email';

export const PUBLIC_ACCOUNT_RATE_LIMITS: Record<
  PublicAccountRateLimitScope,
  { limit: number; windowMs: number }
> = {
  signup: { limit: 5, windowMs: 60_000 },
  'verify-email': { limit: 10, windowMs: 60_000 },
};

const RATE_LIMIT_SCOPE = 'kemfai:public-account-rate-limit-scope';
const MAX_TRACKED_BUCKETS = 10_000;
const NORMAL_BUCKET_LIMIT = MAX_TRACKED_BUCKETS - Object.keys(PUBLIC_ACCOUNT_RATE_LIMITS).length;
const OVERFLOW_CLIENT_KEY = '__overflow__';

interface Bucket {
  count: number;
  resetAtMs: number;
}

interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export const PublicAccountRateLimit = (scope: PublicAccountRateLimitScope) =>
  SetMetadata(RATE_LIMIT_SCOPE, scope);

/**
 * Process-local fixed-window limiter for the two unauthenticated account endpoints.
 * KEMFAI currently deploys one API process; the bounded map prevents client-controlled
 * IP cardinality from becoming an unbounded memory sink. If the bound is exhausted,
 * new addresses share a fail-closed overflow bucket rather than bypassing the limit.
 */
@Injectable()
export class PublicAccountsRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private nextPruneAtMs = 0;

  check(
    scope: PublicAccountRateLimitScope,
    clientKey: string,
    nowMs: number = Date.now(),
  ): RateLimitDecision {
    const config = PUBLIC_ACCOUNT_RATE_LIMITS[scope];
    this.pruneExpired(nowMs);

    let bucketKey = `${scope}:${clientKey}`;
    if (!this.buckets.has(bucketKey) && this.buckets.size >= NORMAL_BUCKET_LIMIT) {
      bucketKey = `${scope}:${OVERFLOW_CLIENT_KEY}`;
    }

    const current = this.buckets.get(bucketKey);
    if (!current || current.resetAtMs <= nowMs) {
      this.buckets.set(bucketKey, { count: 1, resetAtMs: nowMs + config.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (current.count >= config.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAtMs - nowMs) / 1000)),
      };
    }

    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  clear(): void {
    this.buckets.clear();
    this.nextPruneAtMs = 0;
  }

  private pruneExpired(nowMs: number): void {
    if (this.buckets.size < NORMAL_BUCKET_LIMIT || nowMs < this.nextPruneAtMs) return;
    // At capacity, scan at most once per second. New addresses remain on the fail-closed
    // overflow buckets between scans instead of turning cardinality pressure into CPU pressure.
    this.nextPruneAtMs = nowMs + 1_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAtMs <= nowMs) this.buckets.delete(key);
    }
  }
}

const RATE_LIMIT_MESSAGE = {
  en: 'Too many attempts. Please try again later.',
  ar: 'عدد المحاولات كبير جدًا. يُرجى المحاولة مرة أخرى لاحقًا.',
} as const;

type SupportedLocale = keyof typeof RATE_LIMIT_MESSAGE;

function preferredLocale(header: string | string[] | undefined): SupportedLocale {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return 'en';
  const ranked = value
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = Number(params.find((item) => item.trim().startsWith('q='))?.split('=')[1] ?? '1');
      return { tag: tag.toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { tag, q } of ranked) {
    if (q <= 0) continue;
    if (tag === 'ar' || tag.startsWith('ar-')) return 'ar';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return 'en';
}

@Injectable()
export class PublicAccountsRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: PublicAccountsRateLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const scope = this.reflector.get<PublicAccountRateLimitScope>(
      RATE_LIMIT_SCOPE,
      context.getHandler(),
    );
    if (!scope) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const clientKey = request.ip || request.socket.remoteAddress || 'unknown';
    const decision = this.limiter.check(scope, clientKey);
    if (decision.allowed) return true;

    const locale = preferredLocale(request.headers['accept-language']);
    response.setHeader('Retry-After', String(decision.retryAfterSeconds));
    response.setHeader('Content-Language', locale);
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: RATE_LIMIT_MESSAGE[locale],
        error: 'Too Many Requests',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
