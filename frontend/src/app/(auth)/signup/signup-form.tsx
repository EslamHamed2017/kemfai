'use client';

import { useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { getBrowserApiClient } from '@/lib/api-client';
import { classifySignupError, type SignupErrorKind } from './signup-error';
import { LocaleSwitcher } from '@/components/locale-switcher';

/**
 * Mirrors PASSWORD_MIN_LENGTH/PASSWORD_MAX_LENGTH in
 * backend/api/src/modules/accounts/dto/signup.request.dto.ts. Client-side `minLength`/
 * `maxLength` are convenience only (Acceptance Scenario 1.2) — the server's ValidationPipe
 * classification in signup-error.ts remains the authoritative source of truth.
 */
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;

interface SignupFormProps {
  planId?: string;
  billingCycle: 'monthly' | 'annual';
}

export function SignupForm({ planId, billingCycle }: SignupFormProps) {
  const t = useTranslations('signup');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorKind, setErrorKind] = useState<SignupErrorKind | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!planId) {
      setErrorKind('planUnavailable');
      return;
    }

    setSubmitting(true);
    setErrorKind(null);

    try {
      const { error, response } = await getBrowserApiClient().POST('/accounts/signup', {
        body: { email, password, planId, billingCycle, acceptedTerms },
      });

      if (error) {
        setErrorKind(classifySignupError(response.status, error.message));
        return;
      }

      setSucceeded(true);
    } catch {
      setErrorKind('unexpected');
    } finally {
      setSubmitting(false);
    }
  }

  if (succeeded) {
    return (
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      {/* T104/FR-024 — the locale switcher is available at EVERY onboarding step. */}
      <LocaleSwitcher />
        <h1>{t('success.title')}</h1>
        <p>{t('success.body', { email })}</p>
      </main>
    );
  }

  return (
    <main dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      {/* T104/FR-024 — locale switch available on EVERY screen state. */}
      <LocaleSwitcher />
      <h1>{t('title')}</h1>
      <form onSubmit={handleSubmit} noValidate>
        <label htmlFor="signup-email" style={{ display: 'block' }}>
          {t('emailLabel')}
        </label>
        <input
          id="signup-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <label htmlFor="signup-password" style={{ display: 'block' }}>
          {t('passwordLabel')}
        </label>
        <input
          id="signup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          aria-describedby="signup-password-hint"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p id="signup-password-hint">{t('passwordHint')}</p>

        <label htmlFor="signup-accepted-terms" style={{ display: 'block' }}>
          <input
            id="signup-accepted-terms"
            name="acceptedTerms"
            type="checkbox"
            required
            checked={acceptedTerms}
            onChange={(event) => setAcceptedTerms(event.target.checked)}
          />
          {t('acceptedTermsLabel')}
        </label>

        <button type="submit" disabled={submitting} data-testid="signup-submit-button">
          {t(submitting ? 'submitting' : 'submit')}
        </button>

        {errorKind === 'malformedEmail' ? <p role="alert">{t('errors.malformedEmail')}</p> : null}
        {errorKind === 'weakPassword' ? <p role="alert">{t('errors.weakPassword')}</p> : null}
        {errorKind === 'validation' ? <p role="alert">{t('errors.validation')}</p> : null}
        {errorKind === 'unexpected' ? <p role="alert">{t('errors.unexpected')}</p> : null}
        {errorKind === 'planUnavailable' ? (
          <p role="alert">
            {t('planUnavailable.message')} <a href="/plans">{t('planUnavailable.link')}</a>
          </p>
        ) : null}
        {errorKind === 'duplicateEmail' ? (
          <section role="alert">
            <p>{t('duplicateEmail.message')}</p>
            <a href="/login">{t('duplicateEmail.signIn')}</a>
            <a href="/reset-password">{t('duplicateEmail.resetPassword')}</a>
          </section>
        ) : null}
      </form>
    </main>
  );
}
