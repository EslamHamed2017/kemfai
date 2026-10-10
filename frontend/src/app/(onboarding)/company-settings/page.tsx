import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { CompanySettingsScreen } from './company-settings-screen';

export default async function CompanySettingsPage() {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) {
    redirect('/auth/login?returnTo=%2Fcompany-settings');
  }
  return <CompanySettingsScreen />;
}
