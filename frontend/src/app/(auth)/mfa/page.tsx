import { MfaEnrollmentScreen } from './mfa-enrollment-screen';

interface MfaPageProps {
  searchParams: Promise<{ setup?: string | string[] }>;
}

export default async function MfaPage({ searchParams }: MfaPageProps) {
  const { setup } = await searchParams;
  return <MfaEnrollmentScreen returnedFromSetup={setup === 'returned'} />;
}
