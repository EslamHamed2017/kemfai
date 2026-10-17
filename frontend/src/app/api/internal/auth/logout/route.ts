import { cookies } from 'next/headers';
import { getInternalAuthConfig, INTERNAL_SESSION_COOKIE } from '@/lib/auth/internal-auth';
import { RedisSessionStore } from '@/lib/auth/session-store';
import { postInternalLogoutWith } from '@/lib/auth/internal-logout-bff';
export async function POST(request: Request) {
  const config = getInternalAuthConfig();
  return postInternalLogoutWith(request, {
    config,
    sessionId: (await cookies()).get(INTERNAL_SESSION_COOKIE)?.value,
    store: new RedisSessionStore(config.redisUrl),
  });
}
