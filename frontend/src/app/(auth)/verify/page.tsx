import { VerifyEmailScreen } from './verify-email-screen';

interface VerifyPageProps {
  searchParams: Promise<{ token?: string | string[] }>;
}

export default async function VerifyPage({ searchParams }: VerifyPageProps) {
  const { token } = await searchParams;

  return <VerifyEmailScreen token={typeof token === 'string' ? token : undefined} />;
}
