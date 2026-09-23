/** @jest-environment node */
const values = new Map<string, string>();
const ttlByKey = new Map<string, number>();
const fakeRedis = {
  isOpen: true,
  on: jest.fn(), connect: jest.fn(),
  get: jest.fn(async (key: string) => values.get(key) ?? null),
  set: jest.fn(async (key: string, value: string, options: { EX?: number; NX?: boolean; PX?: number }) => {
    if (options.NX && values.has(key)) return null;
    values.set(key, value);
    if (options.EX) ttlByKey.set(key, options.EX);
    return 'OK';
  }),
  del: jest.fn(async (key: string) => { values.delete(key); return 1; }),
  eval: jest.fn(async (script: string, options: { keys: string[]; arguments: string[] }) => {
    const [key] = options.keys;
    if (script.includes("redis.call('GET', KEYS[1]) == ARGV[1]")) {
      if (values.get(key) !== options.arguments[0]) return 0;
      values.delete(key); return 1;
    }
    const raw = values.get(key);
    if (!raw || JSON.parse(raw).refreshToken !== options.arguments[0]) return 0;
    if (options.arguments[1]) values.set(key, options.arguments[1]); else values.delete(key);
    return 1;
  }),
};
jest.mock('redis', () => ({ createClient: () => fakeRedis }));

import { RedisSessionStore } from '../../src/lib/auth/session-store';

describe('Redis session TTL and expiry (T039)', () => {
  beforeEach(() => { values.clear(); ttlByKey.clear(); jest.clearAllMocks(); });

  it('stores tokens under an opaque id with a bounded refresh TTL', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const store = new RedisSessionStore('redis://test');
    const id = await store.create({ accessToken: 'access', refreshToken: 'refresh',
      accessExpiresAt: 1_030_000, refreshExpiresAt: 1_120_000 });
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ttlByKey.get(`kemfai:session:${id}`)).toBe(120);
    expect(await store.get(id)).toMatchObject({ accessToken: 'access', refreshToken: 'refresh' });
    now.mockRestore();
  });

  it('deletes expired session data instead of returning it', async () => {
    const store = new RedisSessionStore('redis://test');
    values.set('kemfai:session:expired', JSON.stringify({ accessToken: 'a', refreshToken: 'r',
      accessExpiresAt: 0, refreshExpiresAt: Date.now() - 1 }));
    await expect(store.get('expired')).resolves.toBeNull();
    expect(values.has('kemfai:session:expired')).toBe(false);
  });

  it('uses uniquely-owned locks and compare-and-swap for rotation and deletion', async () => {
    const store = new RedisSessionStore('redis://test');
    const current = { accessToken: 'a', refreshToken: 'r1', accessExpiresAt: Date.now() + 1_000,
      refreshExpiresAt: Date.now() + 60_000 };
    values.set('kemfai:session:id', JSON.stringify(current));
    await expect(store.tryAcquireRefreshLock('id', 'owner-1', 10_000)).resolves.toBe(true);
    await expect(store.tryAcquireRefreshLock('id', 'owner-2', 10_000)).resolves.toBe(false);
    await store.releaseRefreshLock('id', 'owner-2');
    expect(values.get('kemfai:session-lock:id')).toBe('owner-1');
    await expect(store.rotateIfCurrent('id', 'stale', { ...current, refreshToken: 'r2' })).resolves.toBe(false);
    await expect(store.destroyIfCurrent('id', 'stale')).resolves.toBe(false);
    expect(JSON.parse(values.get('kemfai:session:id')!).refreshToken).toBe('r1');
    await store.releaseRefreshLock('id', 'owner-1');
    expect(values.has('kemfai:session-lock:id')).toBe(false);
  });
});
