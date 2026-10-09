import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { SetupWizardScreen } from './setup-wizard-screen';

export default async function SetupWizardPage() {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) redirect('/auth/login?returnTo=%2Fsetup-wizard');
  return <SetupWizardScreen />;
}
