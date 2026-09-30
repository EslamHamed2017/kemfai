import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { ProvisioningScreen } from './provisioning-screen';

export default async function ProvisioningPage() {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) redirect('/auth/login?returnTo=%2Fprovisioning');
  // Operational configuration: set SUPPORT_EMAIL to a monitored address before deployment.
  // Never fabricate a business contact address or render a dead mailto link.
  const configured = process.env.SUPPORT_EMAIL?.trim();
  const supportEmail = configured && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configured) ? configured : null;
  return <ProvisioningScreen supportEmail={supportEmail} />;
}
