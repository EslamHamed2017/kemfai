import { accessTokenForSession } from './authenticated-session';
import type { AuthConfig } from './config';
import type { SessionStore } from './session-store';

export async function hasAuthenticatedInternalSession(
  sessionId: string | undefined,
  config: AuthConfig,
  store: SessionStore,
): Promise<boolean> {
  if (!sessionId) return false;
  return Boolean(await accessTokenForSession(sessionId, config, store));
}
