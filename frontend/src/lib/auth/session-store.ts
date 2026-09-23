import { createClient, type RedisClientType } from 'redis';
import { randomOpaque } from './pkce';

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export interface SessionStore {
  create(session: StoredSession): Promise<string>;
  get(id: string): Promise<StoredSession | null>;
  tryAcquireRefreshLock(id: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseRefreshLock(id: string, owner: string): Promise<void>;
  rotateIfCurrent(id: string, refreshToken: string, session: StoredSession): Promise<boolean>;
  destroyIfCurrent(id: string, refreshToken: string): Promise<boolean>;
  destroy(id: string): Promise<void>;
}

let client: RedisClientType | undefined;

async function redis(url: string): Promise<RedisClientType> {
  if (!client) {
    client = createClient({ url });
    client.on('error', () => undefined); // never log credentials, URLs, or token-bearing values
  }
  if (!client.isOpen) await client.connect();
  return client;
}

export async function closeRedisSessionStoreConnection(): Promise<void> {
  if (client?.isOpen) await client.quit();
  client = undefined;
}

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redisUrl: string) {}

  async create(session: StoredSession): Promise<string> {
    const id = randomOpaque(32);
    await this.write(id, session);
    return id;
  }

  async get(id: string): Promise<StoredSession | null> {
    const raw = await (await redis(this.redisUrl)).get(`kemfai:session:${id}`);
    if (!raw) return null;
    try {
      const session = JSON.parse(raw) as StoredSession;
      if (session.refreshExpiresAt <= Date.now()) {
        await this.destroyIfCurrent(id, session.refreshToken);
        return null;
      }
      return session;
    } catch {
      // Do not unconditionally delete after a stale read: a concurrent refresh may already
      // have replaced malformed/expired data with a valid rotated session.
      return null;
    }
  }

  async tryAcquireRefreshLock(id: string, owner: string, ttlMs: number): Promise<boolean> {
    const result = await (await redis(this.redisUrl)).set(`kemfai:session-lock:${id}`, owner, {
      NX: true,
      PX: ttlMs,
    });
    return result === 'OK';
  }

  async releaseRefreshLock(id: string, owner: string): Promise<void> {
    await (await redis(this.redisUrl)).eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      { keys: [`kemfai:session-lock:${id}`], arguments: [owner] },
    );
  }

  async rotateIfCurrent(id: string, refreshToken: string, session: StoredSession): Promise<boolean> {
    const ttl = session.refreshExpiresAt - Date.now();
    if (ttl <= 0) return false;
    const result = await (await redis(this.redisUrl)).eval(
      "local v=redis.call('GET',KEYS[1]); if not v then return 0 end; local s=cjson.decode(v); "
        + "if s.refreshToken~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'PX',ARGV[3]); return 1",
      { keys: [`kemfai:session:${id}`], arguments: [refreshToken, JSON.stringify(session), String(ttl)] },
    );
    return result === 1;
  }

  async destroyIfCurrent(id: string, refreshToken: string): Promise<boolean> {
    const result = await (await redis(this.redisUrl)).eval(
      "local v=redis.call('GET',KEYS[1]); if not v then return 0 end; local s=cjson.decode(v); "
        + "if s.refreshToken~=ARGV[1] then return 0 end; return redis.call('DEL',KEYS[1])",
      { keys: [`kemfai:session:${id}`], arguments: [refreshToken] },
    );
    return result === 1;
  }

  async destroy(id: string): Promise<void> {
    await (await redis(this.redisUrl)).del(`kemfai:session:${id}`);
  }

  private async write(id: string, session: StoredSession): Promise<void> {
    const ttl = Math.floor((session.refreshExpiresAt - Date.now()) / 1000);
    if (ttl <= 0) {
      await this.destroy(id);
      return;
    }
    await (await redis(this.redisUrl)).set(`kemfai:session:${id}`, JSON.stringify(session), { EX: ttl });
  }
}
