import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { DraftComposer } from './draft-composer';

export default async function DraftsPage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<{ companyId?: string }>;
}) {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) {
    redirect('/auth/login?returnTo=%2Faccounting%2Fdrafts');
  }

  const companyId = (await searchParams).companyId;
  return <DraftComposer companyId={companyId} />;
}
