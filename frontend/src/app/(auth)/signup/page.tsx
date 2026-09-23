import { SignupForm } from './signup-form';

interface SignupPageProps {
  searchParams: Promise<{ plan?: string | string[]; cycle?: string | string[] }>;
}

/**
 * T037 — carries the plan/billing-cycle choice from the public plan list (T036's
 * `/signup?plan=<id>&cycle=<cycle>` link) into signup without requiring re-entry
 * (Acceptance Scenario 1.1).
 */
export default async function SignupPage({ searchParams }: SignupPageProps) {
  const { plan, cycle } = await searchParams;

  return (
    <SignupForm
      planId={typeof plan === 'string' ? plan : undefined}
      billingCycle={cycle === 'annual' ? 'annual' : 'monthly'}
    />
  );
}
