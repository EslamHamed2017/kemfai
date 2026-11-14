import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { JournalsCurrenciesScreen } from './journals-currencies-screen';

export default async function JournalsCurrenciesPage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<{ companyId?: string }>;
}) {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) {
    redirect('/auth/login?returnTo=%2Faccounting%2Fjournals-currencies');
  }

  const companyId = (await searchParams).companyId;
  return <JournalsCurrenciesScreen companyId={companyId} />;
}
