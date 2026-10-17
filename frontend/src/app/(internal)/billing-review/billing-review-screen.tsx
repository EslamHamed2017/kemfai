'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { LocaleSwitcher } from '@/components/locale-switcher';

type Status = 'PendingReview' | 'MoreInfoRequested';
type History = {
  status: string;
  changedAt: string;
  changedBy?: string | null;
  notes?: string | null;
};
type Item = {
  id: string;
  status: Status;
  submittedAt: string;
  statusHistory: History[];
  customerEmail: string;
  tenantId: string;
  planName: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  amount: number;
  currency: string;
  bankReference: string;
  proofDownloadUrl: string;
};
const validUrl = (value: string) => {
  try {
    const url = new URL(value);
    const allowed = (process.env.NEXT_PUBLIC_PAYMENT_PROOF_ORIGINS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    return ['http:', 'https:'].includes(url.protocol) && allowed.includes(url.origin);
  } catch {
    return false;
  }
};
const isHistory = (v: unknown): v is History =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  typeof (v as Record<string, unknown>).status === 'string' &&
  typeof (v as Record<string, unknown>).changedAt === 'string';
const isItem = (v: unknown): v is Item => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const x = v as Record<string, unknown>;
  return (
    typeof x.id === 'string' &&
    ['PendingReview', 'MoreInfoRequested'].includes(String(x.status)) &&
    typeof x.submittedAt === 'string' &&
    Array.isArray(x.statusHistory) &&
    x.statusHistory.every(isHistory) &&
    typeof x.customerEmail === 'string' &&
    typeof x.tenantId === 'string' &&
    typeof x.planName === 'string' &&
    typeof x.billingPeriodStart === 'string' &&
    typeof x.billingPeriodEnd === 'string' &&
    typeof x.amount === 'number' &&
    Number.isFinite(x.amount) &&
    typeof x.currency === 'string' &&
    typeof x.bankReference === 'string' &&
    typeof x.proofDownloadUrl === 'string'
  );
};

export function BillingReviewScreen() {
  const t = useTranslations('billingReview'),
    locale = useLocale() === 'ar' ? 'ar' : 'en',
    rtl = locale === 'ar';
  const [items, setItems] = useState<Item[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'denied' | 'expired'>('loading');
  const [dialog, setDialog] = useState<'approve' | 'reject' | 'request-more-info' | null>(null),
    [note, setNote] = useState(''),
    [fieldError, setFieldError] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null),
    [stale, setStale] = useState(false);
  const generation = useRef(0),
    inFlight = useRef(false),
    returnFocus = useRef<HTMLButtonElement | null>(null),
    dialogRef = useRef<HTMLDivElement | null>(null);
  const load = useCallback(async (preserve = false) => {
    const gen = ++generation.current;
    if (!preserve) setPhase('loading');
    try {
      const r = await fetch('/api/internal/billing/review-queue', { cache: 'no-store' });
      if (gen !== generation.current) return;
      if (r.status === 401) {
        setPhase('expired');
        setItems([]);
        return;
      }
      if (r.status === 403) {
        setPhase('denied');
        setItems([]);
        return;
      }
      const body: unknown = await r.json();
      if (!r.ok || !Array.isArray(body) || !body.every(isItem)) {
        setPhase('error');
        return;
      }
      setItems(body);
      setSelected((current) =>
        current && body.some((x) => x.id === current) ? current : (body[0]?.id ?? null),
      );
      setPhase('ready');
      setStale(false);
    } catch {
      if (gen === generation.current) setPhase('error');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (dialog) {
      const target = dialogRef.current?.querySelector<HTMLElement>(
        'textarea, button:not([disabled])',
      );
      target?.focus();
    }
  }, [dialog]);
  const item = items.find((x) => x.id === selected) ?? null;
  const actionable = item?.status === 'PendingReview' && !stale;
  const displayLocale = rtl ? 'ar-u-nu-arab' : 'en';
  const dt = new Intl.DateTimeFormat(displayLocale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  const day = new Intl.DateTimeFormat(displayLocale, { dateStyle: 'medium', timeZone: 'UTC' });
  const money = (v: number, c: string) => {
    try {
      return new Intl.NumberFormat(displayLocale, { style: 'currency', currency: c }).format(v);
    } catch {
      return `${new Intl.NumberFormat(displayLocale).format(v)} ${c}`;
    }
  };
  const open = (kind: typeof dialog, e: React.MouseEvent<HTMLButtonElement>) => {
    returnFocus.current = e.currentTarget;
    setDialog(kind);
    setNote('');
    setFieldError(false);
    setMessage(null);
  };
  const close = () => {
    setDialog(null);
    setNote('');
    queueMicrotask(() => returnFocus.current?.focus());
  };
  const containDialogFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'textarea,button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
      ),
    );
    if (!controls.length) return;
    const first = controls[0],
      last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  async function decide() {
    if (!item || !dialog || inFlight.current || !actionable) return;
    if (dialog !== 'approve' && (!note.trim() || note.length > 4000)) {
      setFieldError(true);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    const body =
      dialog === 'reject'
        ? { reason: note.trim() }
        : dialog === 'request-more-info'
          ? { details: note.trim() }
          : undefined;
    try {
      const r = await fetch(`/api/internal/billing/payment-submissions/${item.id}/${dialog}`, {
        method: 'POST',
        headers: { ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.status === 401) {
        setPhase('expired');
        setItems([]);
        close();
        return;
      }
      if (r.status === 403) {
        setPhase('denied');
        close();
        return;
      }
      if (r.status === 422) {
        setFieldError(true);
        return;
      }
      if ([404, 409].includes(r.status)) {
        setMessage(t(r.status === 409 ? 'messages.conflict' : 'messages.missing'));
        close();
        await load(true);
        return;
      }
      if (!r.ok) {
        setMessage(t('messages.unknown'));
        setStale(true);
        close();
        await load(true);
        return;
      }
      setMessage(
        t(
          dialog === 'approve'
            ? 'messages.approved'
            : dialog === 'reject'
              ? 'messages.rejected'
              : 'messages.moreInfo',
        ),
      );
      close();
      await load(true);
    } catch {
      setMessage(t('messages.unknown'));
      setStale(true);
      close();
      await load(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const shell = {
    maxWidth: 1100,
    marginInline: 'auto',
    padding: '2rem',
    textAlign: 'start' as const,
  };
  if (phase !== 'ready')
    return (
      <main dir={rtl ? 'rtl' : 'ltr'} style={shell}>
        <LocaleSwitcher />
        <h1>{t('title')}</h1>
        <section role={phase === 'loading' ? 'status' : 'alert'} aria-busy={phase === 'loading'}>
          <p>{t(`states.${phase}`)}</p>
          {phase === 'error' && <button onClick={() => void load()}>{t('actions.retry')}</button>}
          {phase === 'expired' && <a href="/internal-auth/login">{t('actions.signIn')}</a>}
        </section>
      </main>
    );
  return (
    <main dir={rtl ? 'rtl' : 'ltr'} style={shell} data-testid="billing-review">
      <div
        data-testid="billing-review-background"
        inert={dialog ? true : undefined}
        aria-hidden={dialog ? true : undefined}
      >
        <header style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
          <div>
            <h1>{t('title')}</h1>
            <p>{t('intro')}</p>
          </div>
          <LocaleSwitcher />
        </header>
        {message && (
          <p role="status" aria-live="polite">
            {message}
          </p>
        )}
        {items.length === 0 ? (
          <section>
            <h2>{t('states.emptyTitle')}</h2>
            <p>{t('states.empty')}</p>
            <button onClick={() => void load()}>{t('actions.refresh')}</button>
          </section>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(15rem,1fr) minmax(0,2fr)',
              gap: '1.5rem',
            }}
          >
            <nav aria-label={t('queueLabel')}>
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {items.map((x) => (
                  <li key={x.id}>
                    <button
                      style={{ width: '100%', textAlign: 'start', padding: '1rem' }}
                      aria-current={x.id === selected ? 'true' : undefined}
                      onClick={() => {
                        setSelected(x.id);
                        setMessage(null);
                      }}
                    >
                      <bdi>{x.customerEmail}</bdi>
                      <br />
                      {money(x.amount, x.currency)}
                      <br />
                      <span>{t(`status.${x.status}`)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            {item && (
              <article aria-labelledby="review-detail-title">
                <h2 id="review-detail-title">{t('detailTitle')}</h2>
                <dl>
                  {(
                    [
                      ['customer', item.customerEmail],
                      ['tenant', item.tenantId],
                      ['plan', item.planName],
                      [
                        'period',
                        `${day.format(new Date(item.billingPeriodStart + 'T00:00:00Z'))} – ${day.format(new Date(item.billingPeriodEnd + 'T00:00:00Z'))}`,
                      ],
                      ['amount', money(item.amount, item.currency)],
                      ['reference', item.bankReference],
                      ['submitted', dt.format(new Date(item.submittedAt))],
                      ['currentStatus', t(`status.${item.status}`)],
                    ] as const
                  ).map(([k, v]) => (
                    <div key={k}>
                      <dt>
                        <strong>{t(`fields.${k}`)}</strong>
                      </dt>
                      <dd>
                        <bdi>{v}</bdi>
                      </dd>
                    </div>
                  ))}
                </dl>
                {validUrl(item.proofDownloadUrl) ? (
                  <a
                    href={item.proofDownloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                  >
                    {t('actions.proof')}
                  </a>
                ) : (
                  <p role="alert">{t('messages.unsafeProof')}</p>
                )}
                <section aria-labelledby="history-title">
                  <h3 id="history-title">{t('history')}</h3>
                  <ol>
                    {item.statusHistory.map((h, i) => (
                      <li key={`${h.changedAt}-${i}`}>
                        <span>
                          {t.has(`status.${h.status}`)
                            ? t(`status.${h.status}`)
                            : t('status.unknown')}
                        </span>{' '}
                        — <time dateTime={h.changedAt}>{dt.format(new Date(h.changedAt))}</time>
                        {h.notes && <p>{h.notes}</p>}
                      </li>
                    ))}
                  </ol>
                </section>
                {item.status === 'MoreInfoRequested' ? (
                  <p role="status">{t('messages.awaitingCustomer')}</p>
                ) : (
                  <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
                    <button disabled={busy || !actionable} onClick={(e) => open('approve', e)}>
                      {t('actions.approve')}
                    </button>
                    <button disabled={busy || !actionable} onClick={(e) => open('reject', e)}>
                      {t('actions.reject')}
                    </button>
                    <button
                      disabled={busy || !actionable}
                      onClick={(e) => open('request-more-info', e)}
                    >
                      {t('actions.moreInfo')}
                    </button>
                  </div>
                )}
              </article>
            )}
          </div>
        )}
      </div>
      {dialog && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="decision-title"
          onKeyDown={containDialogFocus}
          style={{
            position: 'fixed',
            inset: '20%',
            background: 'white',
            color: 'black',
            border: '2px solid',
            padding: '2rem',
          }}
        >
          <h2 id="decision-title">{t(`dialog.${dialog}.title`)}</h2>
          <p>
            {t(`dialog.${dialog}.confirm`, {
              customer: item?.customerEmail ?? '',
              tenant: item?.tenantId ?? '',
            })}
          </p>
          {dialog !== 'approve' && (
            <div>
              <label htmlFor="decision-note">{t(`dialog.${dialog}.label`)}</label>
              <textarea
                autoFocus
                id="decision-note"
                maxLength={4000}
                value={note}
                aria-invalid={fieldError}
                aria-describedby={fieldError ? 'decision-error' : undefined}
                onChange={(e) => {
                  setNote(e.target.value);
                  setFieldError(false);
                }}
              />
              {fieldError && (
                <p id="decision-error" role="alert">
                  {t('dialog.required')}
                </p>
              )}
            </div>
          )}
          <button disabled={busy} onClick={() => void decide()}>
            {busy ? t('actions.deciding') : t('actions.confirm')}
          </button>
          <button disabled={busy} onClick={close}>
            {t('actions.cancel')}
          </button>
        </div>
      )}
    </main>
  );
}
