import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { BillingScreen } from './billing-screen';

export default async function BillingPage() {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) {
    redirect('/auth/login?returnTo=%2Fbilling');
  }
  return <BillingScreen />;
}
