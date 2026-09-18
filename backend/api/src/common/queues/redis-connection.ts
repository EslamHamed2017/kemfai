import type { QueueOptions } from 'bullmq';

/**
 * Single place where the BFF's Redis connection is derived from the `REDIS_URL` env var
 * wired by infra/docker/docker-compose.yml (`redis://redis:6379`; local default
 * `redis://localhost:6379` matches the compose port mapping on 127.0.0.1:6379).
 *
 * `maxRetriesPerRequest: null` is required by BullMQ's blocking connections; keeping it
 * here means no queue registration site can accidentally omit it.
 */
export function redisConnectionFromUrl(
  url: string = process.env.REDIS_URL ?? 'redis://localhost:6379',
): NonNullable<QueueOptions['connection']> {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : undefined,
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
