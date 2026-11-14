import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { DimensionsScreen } from './dimensions-screen';

export default async function DimensionsPage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<{ companyId?: string }>;
}) {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) {
    redirect('/auth/login?returnTo=%2Faccounting%2Fdimensions');
  }

  const companyId = (await searchParams).companyId;
  return <DimensionsScreen companyId={companyId} />;
}
