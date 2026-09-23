'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

type Status = 'idle' | 'enrolling' | 'setup' | 'confirming' | 'complete' | 'error';

export function MfaEnrollmentScreen({ returnedFromSetup = false }: { returnedFromSetup?: boolean }) {
  const t = useTranslations('mfa');
  const router = useRouter();
  const [status, setStatus] = useState<Status>(returnedFromSetup ? 'setup' : 'idle');

  async function post(operation: 'enroll' | 'confirm') {
    const response = await fetch(`/api/accounts/mfa/${operation}`, { method: 'POST' });
    if (response.status === 401) {
      window.location.assign('/auth/login');
      return null;
    }
    if (!response.ok) throw new Error('MFA request failed');
    return response;
  }

  async function enroll() {
    setStatus('enrolling');
    try {
      if (await post('enroll')) setStatus('setup');
    } catch {
      setStatus('error');
    }
  }

  function openHostedSetup() {
    // Keycloak sees CONFIGURE_TOTP on the authenticated user and renders its hosted QR/code flow.
    window.location.assign('/auth/login?returnTo=%2Fmfa%3Fsetup%3Dreturned');
  }

  async function confirm() {
    setStatus('confirming');
    try {
      if (await post('confirm')) setStatus('complete');
    } catch {
      setStatus('error');
    }
  }

  return (
    <main aria-labelledby="mfa-title">
      <h1 id="mfa-title">{t('title')}</h1>
      <p>{t('description')}</p>
      <p>{t('optional')}</p>

      {status === 'complete' ? (
        <div role="status">
          <h2>{t('complete.title')}</h2>
          <p>{t('complete.body')}</p>
          <button type="button" onClick={() => router.push('/provisioning')}>{t('continue')}</button>
        </div>
      ) : (
        <>
          {status === 'error' ? <p role="alert">{t('error')}</p> : null}
          {status === 'setup' ? (
            <section aria-labelledby="mfa-setup-title">
              <h2 id="mfa-setup-title">{t('setup.title')}</h2>
              <p>{t('setup.body')}</p>
              <button type="button" onClick={openHostedSetup}>{t('setup.open')}</button>
              <button type="button" onClick={confirm}>{t('confirm')}</button>
            </section>
          ) : (
            <button type="button" onClick={enroll} disabled={status === 'enrolling' || status === 'confirming'}>
              {t(status === 'enrolling' ? 'enrolling' : status === 'confirming' ? 'confirming' : 'enable')}
            </button>
          )}
          <button type="button" onClick={() => router.push('/provisioning')}>{t('skip')}</button>
        </>
      )}
    </main>
  );
}
