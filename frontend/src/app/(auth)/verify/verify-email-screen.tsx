'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { getBrowserApiClient } from '@/lib/api-client';
import { LocaleSwitcher } from '@/components/locale-switcher';

type VerificationFailure = 'invalid' | 'expired' | 'used';
type VerificationStatus = 'verifying' | 'success' | VerificationFailure;
type ResendStatus = 'idle' | 'sending' | 'sent' | 'error';

interface VerifyEmailScreenProps {
  token?: string;
}

function verificationFailure(error: unknown): VerificationFailure {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return 'invalid';
  const reason = (error as { reason?: unknown }).reason;
  if (reason === 'expired' || reason === 'used') return reason;
  // An unknown or superseded link is intentionally presented as invalid: both
  // require the same safe recovery action without exposing account details.
  return 'invalid';
}

/**
 * T038 — consumes the token from the emailed verification link (FR-021, Acceptance
 * Scenario 1.3) and offers resend-verification (Acceptance Scenario 1.5) once the
 * link is missing, expired, invalid, or superseded. `POST /accounts/verify-email`
 * only documents 200/410, so any other failure (network error, thrown exception) is
 * treated the same as an expired link — never left stuck on "verifying" (FR-012).
 */
export function VerifyEmailScreen({ token }: VerifyEmailScreenProps) {
  const t = useTranslations('verifyEmail');
  const [status, setStatus] = useState<VerificationStatus>(token ? 'verifying' : 'invalid');
  const [resendEmail, setResendEmail] = useState('');
  const [resendStatus, setResendStatus] = useState<ResendStatus>('idle');

  useEffect(() => {
    if (!token) {
      return;
    }

    let cancelled = false;
    getBrowserApiClient()
      .POST('/accounts/verify-email', { body: { token } })
      .then(({ error }) => {
        if (!cancelled) {
          setStatus(error ? verificationFailure(error) : 'success');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('invalid');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleResend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResendStatus('sending');

    try {
      const { error } = await getBrowserApiClient().POST('/accounts/resend-verification', {
        body: { email: resendEmail },
      });
      setResendStatus(error ? 'error' : 'sent');
    } catch {
      setResendStatus('error');
    }
  }

  if (status === 'verifying') {
    return (
      <main aria-live="polite">
        {/* T104/FR-024 — the locale switcher is available at EVERY onboarding step. */}
        <LocaleSwitcher />
        <p>{t('verifying')}</p>
      </main>
    );
  }

  if (status === 'success') {
    return (
      <main>
        {/* T104/FR-024 — locale switch available on EVERY screen state. */}
        <LocaleSwitcher />
        <h1>{t('success.title')}</h1>
        <p>{t('success.body')}</p>
        <a href="/auth/login?returnTo=%2Fmfa">{t('success.continue')}</a>
      </main>
    );
  }

  return (
    <main>
      {/* T104/FR-024 — locale switch available on EVERY screen state. */}
      <LocaleSwitcher />
      <div data-testid="verify-invalid-message" data-verification-error={status}>
        <h1>{t(`${status}.title`)}</h1>
        <p>{t(`${status}.body`)}</p>
      </div>
      {resendStatus === 'sent' ? (
        <p role="status">{t('resend.confirmation')}</p>
      ) : (
        <form onSubmit={handleResend}>
          <label htmlFor="resend-email" style={{ display: 'block' }}>
            {t('resend.emailLabel')}
          </label>
          <input
            id="resend-email"
            name="email"
            type="email"
            required
            value={resendEmail}
            onChange={(event) => setResendEmail(event.target.value)}
          />
          <button
            type="submit"
            disabled={resendStatus === 'sending'}
            data-testid="verify-resend-button"
          >
            {t(resendStatus === 'sending' ? 'resend.sending' : 'resend.submit')}
          </button>
          {resendStatus === 'error' ? <p role="alert">{t('resend.error')}</p> : null}
        </form>
      )}
    </main>
  );
}
