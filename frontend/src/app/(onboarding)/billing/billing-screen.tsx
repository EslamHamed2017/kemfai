'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { LocaleSwitcher } from '@/components/locale-switcher';
import { SignOutButton } from '@/components/sign-out-button';
import type { components } from '@/lib/api-client';

type SubscriptionView = components['schemas']['SubscriptionView'];
type PaymentSubmissionView = components['schemas']['PaymentSubmissionView'];
type PaymentSubmissionStatus = NonNullable<PaymentSubmissionView['status']>;
type Phase = 'loading' | 'active' | 'sessionExpired' | 'unavailable';
type UploadError =
  | 'unsupportedType'
  | 'tooLarge'
  | 'unreadable'
  | 'duplicate'
  | 'bankReference'
  | 'general';

const STATUS_KEYS: Record<PaymentSubmissionStatus, string> = {
  PendingReview: 'pendingReview',
  Approved: 'approved',
  Rejected: 'rejected',
  MoreInfoRequested: 'moreInfoRequested',
};

function isSubscriptionView(value: unknown): value is Required<SubscriptionView> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const view = value as Record<string, unknown>;
  return (
    typeof view.status === 'string' &&
    typeof view.billingPeriodStart === 'string' &&
    typeof view.billingPeriodEnd === 'string' &&
    typeof view.amountDue === 'number' &&
    Number.isFinite(view.amountDue) &&
    typeof view.currency === 'string' &&
    typeof view.bankInstructions === 'string' &&
    typeof view.paymentReference === 'string'
  );
}

function isPaymentSubmissionView(value: unknown): value is Required<PaymentSubmissionView> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const view = value as Record<string, unknown>;
  return (
    typeof view.id === 'string' &&
    typeof view.status === 'string' &&
    Object.hasOwn(STATUS_KEYS, view.status) &&
    typeof view.submittedAt === 'string' &&
    Array.isArray(view.statusHistory)
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function uploadErrorFor(status: number, body: unknown): UploadError {
  const code =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as { code?: unknown }).code
      : undefined;
  if (code === 'PAYMENT_PROOF_UNSUPPORTED_TYPE') return 'unsupportedType';
  if (code === 'PAYMENT_PROOF_TOO_LARGE') return 'tooLarge';
  if (code === 'PAYMENT_PROOF_UNREADABLE') return 'unreadable';
  if (code === 'PAYMENT_SUBMISSION_UNRESOLVED_DUPLICATE' || status === 409) return 'duplicate';
  if (code === 'PAYMENT_BANK_REFERENCE_REQUIRED') return 'bankReference';
  return 'general';
}

export function BillingScreen() {
  const t = useTranslations('billing');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [phase, setPhase] = useState<Phase>('loading');
  const [subscription, setSubscription] = useState<Required<SubscriptionView> | null>(null);
  const [submission, setSubmission] = useState<Required<PaymentSubmissionView> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState<UploadError | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const uploadController = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setPhase('loading');
    setUploadError(null);
    try {
      const [subscriptionResponse, submissionsResponse] = await Promise.all([
        fetch('/api/billing/subscription', { cache: 'no-store', signal: controller.signal }),
        fetch('/api/billing/payment-submissions', { cache: 'no-store', signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      if (subscriptionResponse.status === 401 || submissionsResponse.status === 401) {
        setPhase('sessionExpired');
        return;
      }
      const [subscriptionBody, submissionsBody] = await Promise.all([
        readJson(subscriptionResponse),
        readJson(submissionsResponse),
      ]);
      if (
        !subscriptionResponse.ok ||
        !submissionsResponse.ok ||
        !isSubscriptionView(subscriptionBody) ||
        !Array.isArray(submissionsBody) ||
        !submissionsBody.every(isPaymentSubmissionView)
      ) {
        setPhase('unavailable');
        return;
      }
      setSubscription(subscriptionBody);
      setSubmission(submissionsBody[0] ?? null);
      setPhase('active');
    } catch {
      if (!controller.signal.aborted) setPhase('unavailable');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadController.current?.abort();
      uploadController.current?.abort();
    };
  }, [load]);

  async function submitProof(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting || submission?.status === 'PendingReview') return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const controller = new AbortController();
    uploadController.current?.abort();
    uploadController.current = controller;
    setSubmitting(true);
    setUploadError(null);
    try {
      const response = await fetch('/api/billing/payment-submissions', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
      const body = await readJson(response);
      if (controller.signal.aborted) return;
      if (response.status === 401) {
        setPhase('sessionExpired');
        return;
      }
      if (!response.ok) {
        setUploadError(uploadErrorFor(response.status, body));
        return;
      }
      if (!isPaymentSubmissionView(body)) {
        setUploadError('general');
        return;
      }
      setSubmission(body);
      form.reset();
    } catch {
      if (!controller.signal.aborted) setUploadError('general');
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  const shellStyle = {
    width: '100%',
    maxWidth: 800,
    marginInline: 'auto',
    padding: '2rem',
    boxSizing: 'border-box' as const,
    textAlign: 'start' as const,
  };
  const cardStyle = {
    border: '1px solid currentColor',
    borderRadius: 4,
    padding: '1rem',
    marginBlock: '1rem',
    minWidth: 0,
    overflowWrap: 'anywhere' as const,
  };
  const header = (
    <header style={{ display: 'flex', gap: '1rem', justifyContent: 'space-between' }}>
      <LocaleSwitcher />
      <SignOutButton />
    </header>
  );

  if (phase === 'loading') {
    return (
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'} style={shellStyle} aria-labelledby="billing-title">
        {header}
        <h1 id="billing-title">{t('title')}</h1>
        <p role="status" aria-live="polite" aria-busy="true" data-testid="billing-loading">
          {t('loading')}
        </p>
      </main>
    );
  }

  if (phase === 'sessionExpired') {
    return (
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'} style={shellStyle}>
        {header}
        <section role="alert">
          <h1>{t('errors.sessionExpired')}</h1>
          <Link href="/auth/login?returnTo=%2Fbilling">{t('actions.signIn')}</Link>
        </section>
      </main>
    );
  }

  if (phase === 'unavailable' || !subscription) {
    return (
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'} style={shellStyle}>
        {header}
        <section role="alert">
          <h1>{t('errors.unavailable')}</h1>
          <button type="button" onClick={() => void load()}>
            {t('actions.retry')}
          </button>
        </section>
      </main>
    );
  }

  const displayLocale = locale === 'ar' ? 'ar-u-nu-arab' : 'en';
  const dateFormatter = new Intl.DateTimeFormat(displayLocale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const formatDate = (value: string) => dateFormatter.format(new Date(`${value}T00:00:00Z`));
  const pendingReview = submission?.status === 'PendingReview';

  return (
    <main
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      style={shellStyle}
      aria-labelledby="billing-title"
      data-testid="billing-screen"
    >
      {header}
      <h1 id="billing-title">{t('title')}</h1>

      <section style={cardStyle} data-testid="billing-bank-instructions">
        <h2>{t('bankInstructions')}</h2>
        <p>{subscription.bankInstructions}</p>
      </section>

      <section style={cardStyle} aria-label={t('paymentDetails')}>
        <p data-testid="billing-payment-reference">
          <strong>{t('paymentReference')}</strong>: <bdi>{subscription.paymentReference}</bdi>
        </p>
        <p data-testid="billing-amount-due">
          <strong>{t('amountDue')}</strong>:{' '}
          {new Intl.NumberFormat(displayLocale).format(subscription.amountDue)} {subscription.currency}
        </p>
        <p data-testid="billing-period">
          <strong>{t('billingPeriod')}</strong>:{' '}
          <time dateTime={subscription.billingPeriodStart} data-testid="billing-period-start">
            {formatDate(subscription.billingPeriodStart)}
          </time>{' '}
          {t('periodSeparator')}{' '}
          <time dateTime={subscription.billingPeriodEnd} data-testid="billing-period-end">
            {formatDate(subscription.billingPeriodEnd)}
          </time>
        </p>
      </section>

      {submission && (
        <section style={cardStyle} aria-labelledby="billing-status-title">
          <h2 id="billing-status-title">{t('status.title')}</h2>
          <p role="status" data-testid="billing-submission-status">
            {t(`status.${STATUS_KEYS[submission.status]}`)}
          </p>
          <p>
            {t('status.submittedAt')}:{' '}
            <time dateTime={submission.submittedAt} data-testid="billing-submission-date">
              {dateFormatter.format(new Date(submission.submittedAt))}
            </time>
          </p>
        </section>
      )}

      <form
        data-testid="billing-upload-form"
        onSubmit={(event) => void submitProof(event)}
        style={{ ...cardStyle, display: 'grid', gap: '1rem' }}
      >
        <h2>{t('form.title')}</h2>
        {pendingReview && (
          <p role="status" data-testid="billing-duplicate-block">
            {t('errors.duplicate')}
          </p>
        )}
        {uploadError && (
          <p role="alert" data-testid="billing-upload-error">
            {t(`errors.${uploadError}`)}
          </p>
        )}
        {submitting && (
          <p role="status" aria-live="polite">
            {t('form.submitting')}
          </p>
        )}
        <div>
          <label htmlFor="billing-bank-reference" style={{ display: 'block' }}>
            {t('form.bankReference')}
          </label>
          <input
            id="billing-bank-reference"
            name="bankReference"
            type="text"
            required
            disabled={pendingReview || submitting}
            data-testid="billing-bank-reference-input"
          />
        </div>
        <div>
          <label htmlFor="billing-proof-file" style={{ display: 'block' }}>
            {t('form.proofFile')}
          </label>
          <input
            id="billing-proof-file"
            name="proofFile"
            type="file"
            required
            accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"
            disabled={pendingReview || submitting}
            data-testid="billing-proof-file-input"
          />
          <p id="billing-proof-help">{t('form.proofHelp')}</p>
        </div>
        <button
          type="submit"
          disabled={pendingReview || submitting}
          data-testid="billing-submit-proof"
        >
          {submitting ? t('form.submitting') : t('form.submit')}
        </button>
      </form>
    </main>
  );
}
