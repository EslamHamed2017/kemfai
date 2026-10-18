import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getSupportGrants } from '@/lib/auth/support-access-bff';
import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { isSupportAccessGrant } from '@/lib/support-access';
import { SupportAccessScreen } from './support-access-screen';

export default async function SupportAccessPage() {
  if (!(await cookies()).get(SESSION_COOKIE)?.value)
    redirect('/auth/login?returnTo=%2Fsupport-access');
  const response = await getSupportGrants();
  if (response.status === 403 || response.status === 404) notFound();
  if (response.ok) {
    const value: unknown = await response.json();
    if (Array.isArray(value) && value.every(isSupportAccessGrant))
      return <SupportAccessScreen initialGrants={value} />;
  }
  return <SupportAccessScreen />;
}
