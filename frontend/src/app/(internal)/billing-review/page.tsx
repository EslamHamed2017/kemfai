import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { BillingReviewScreen } from './billing-review-screen';
import { getInternalAuthConfig, INTERNAL_SESSION_COOKIE } from '@/lib/auth/internal-auth';
import { hasAuthenticatedInternalSession } from '@/lib/auth/internal-page-auth';
import { RedisSessionStore } from '@/lib/auth/session-store';

export default async function BillingReviewPage() {
  const config = getInternalAuthConfig();
  const sessionId = (await cookies()).get(INTERNAL_SESSION_COOKIE)?.value;
  if (
    !(await hasAuthenticatedInternalSession(
      sessionId,
      config,
      new RedisSessionStore(config.redisUrl),
    ))
  )
    redirect('/internal-auth/login');
  return <BillingReviewScreen />;
}
