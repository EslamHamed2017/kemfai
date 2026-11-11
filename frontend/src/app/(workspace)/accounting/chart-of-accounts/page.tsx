import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { ChartOfAccountsScreen } from './chart-of-accounts-screen';

export default async function ChartOfAccountsPage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<{ companyId?: string }>;
}) {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) {
    redirect('/auth/login?returnTo=%2Faccounting%2Fchart-of-accounts');
  }

  const companyId = (await searchParams).companyId;
  return <ChartOfAccountsScreen companyId={companyId} />;
}
