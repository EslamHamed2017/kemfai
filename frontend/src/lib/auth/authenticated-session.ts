import type { AuthConfig } from './config';
import { refreshSession } from './oauth';
import type { SessionStore } from './session-store';

const REFRESH_SKEW_MS = 30_000;
const REFRESH_LOCK_TTL_MS = 10_000;
const REFRESH_WAIT_ATTEMPTS = 20;
const REFRESH_WAIT_MS = 25;

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function accessTokenForSession(
  id: string,
  config: AuthConfig,
  store: SessionStore,
): Promise<string | null> {
  let current = await store.get(id);
  if (!current) return null;
  if (current.accessExpiresAt > Date.now() + REFRESH_SKEW_MS) return current.accessToken;

  const owner = crypto.randomUUID();
  let locked = await store.tryAcquireRefreshLock(id, owner, REFRESH_LOCK_TTL_MS);
  for (let attempt = 0; !locked && attempt < REFRESH_WAIT_ATTEMPTS; attempt += 1) {
    await delay(REFRESH_WAIT_MS);
    current = await store.get(id);
    if (!current) return null;
    if (current.accessExpiresAt > Date.now() + REFRESH_SKEW_MS) return current.accessToken;
    locked = await store.tryAcquireRefreshLock(id, owner, REFRESH_LOCK_TTL_MS);
  }
  if (!locked) return null;

  try {
    current = await store.get(id);
    if (!current) return null;
    if (current.accessExpiresAt > Date.now() + REFRESH_SKEW_MS) return current.accessToken;
    const refreshToken = current.refreshToken;
    const rotated = await refreshSession(config, current);
    if (await store.rotateIfCurrent(id, refreshToken, rotated)) return rotated.accessToken;
    return (await store.get(id))?.accessToken ?? null;
  } catch {
    if (current) await store.destroyIfCurrent(id, current.refreshToken);
    return null;
  } finally {
    await store.releaseRefreshLock(id, owner);
  }
}
