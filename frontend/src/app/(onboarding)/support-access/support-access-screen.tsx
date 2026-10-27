'use client';

import { Button, InlineLoading, InlineNotification, Tag, Tile } from '@carbon/react';
import { useLocale, useTranslations } from 'next-intl';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { SignOutButton } from '@/components/sign-out-button';
import { isSupportAccessGrant, type SupportAccessGrantView } from '@/lib/support-access';

type Phase = 'loading' | 'ready' | 'error' | 'session';
export function SupportAccessScreen({
  initialGrants,
}: {
  initialGrants?: SupportAccessGrantView[];
}) {
  const t = useTranslations('supportAccess');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [phase, setPhase] = useState<Phase>(initialGrants ? 'ready' : 'loading');
  const [grants, setGrants] = useState(initialGrants ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const response = await fetch('/api/support-access/grants', { cache: 'no-store' });
      if (response.status === 401) return setPhase('session');
      const value: unknown = response.ok ? await response.json() : null;
      if (!Array.isArray(value) || !value.every(isSupportAccessGrant)) return setPhase('error');
      setGrants(value);
      setPhase('ready');
    } catch {
      setPhase('error');
    }
  }, []);
  // Always refresh through the authenticated BFF after hydration: server data prevents a
  // blank first paint, while the browser still exercises real loading/error/session states.
  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('create');
    setMessage(null);
    const form = event.currentTarget;
    const local = String(new FormData(form).get('expiresAt') ?? '');
    const parsed = new Date(local);
    try {
      const response = await fetch('/api/support-access/grants', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expiresAt: parsed.toISOString() }),
      });
      if (!response.ok) throw new Error();
      await load();
      form.reset();
    } catch {
      setMessage(t('error'));
    } finally {
      setBusy(null);
    }
  }
  async function revoke(id: string) {
    setBusy(id);
    setMessage(null);
    try {
      const response = await fetch(`/api/support-access/grants/${encodeURIComponent(id)}/revoke`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error();
      await load();
    } catch {
      setMessage(t('error'));
    } finally {
      setBusy(null);
    }
  }
  const format = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(value),
        )
      : '—';
  return (
    <main dir={locale === 'ar' ? 'rtl' : 'ltr'} className="kemfai-support-shell">
      <header className="kemfai-checklist-header">
        <LocaleSwitcher />
        <SignOutButton />
      </header>
      <p className="kemfai-checklist-eyebrow">{t('eyebrow')}</p>
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>
      <form onSubmit={create} className="kemfai-support-form">
        <label htmlFor="support-expiry">{t('expiry')}</label>
        <input
          id="support-expiry"
          name="expiresAt"
          type="datetime-local"
          required
          aria-describedby="support-expiry-help"
        />
        <small id="support-expiry-help">{t('expiryHelp')}</small>
        <Button type="submit" disabled={busy !== null}>
          {busy === 'create' ? t('creating') : t('create')}
        </Button>
      </form>
      {message ? (
        <InlineNotification kind="error" lowContrast hideCloseButton title={message} />
      ) : null}
      <div className="kemfai-support-history-heading">
        <h2>{t('history')}</h2>
        <Button kind="ghost" size="sm" disabled={phase === 'loading'} onClick={() => void load()}>
          {t('refresh')}
        </Button>
      </div>
      {phase === 'loading' ? <InlineLoading description={t('loading')} /> : null}
      {phase === 'session' || phase === 'error' ? (
        <>
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title={t(phase === 'session' ? 'sessionExpired' : 'error')}
          />
          <Button kind="ghost" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </>
      ) : null}
      {phase === 'ready' && grants.length === 0 ? (
        <InlineNotification
          data-testid="support-access-empty"
          kind="info"
          lowContrast
          hideCloseButton
          title={t('empty')}
        />
      ) : null}
      <section className="kemfai-support-history" aria-label={t('history')}>
        {grants.map((grant) => (
          <Tile key={grant.id} className="kemfai-support-grant">
            <div className="kemfai-support-status">
              <Tag
                type={
                  grant.status === 'active' ? 'green' : grant.status === 'expired' ? 'gray' : 'red'
                }
              >
                {t(`status.${grant.status}`)}
              </Tag>
            </div>
            <dl>
              <div>
                <dt>{t('role')}</dt>
                <dd>{grant.granteeRole}</dd>
              </div>
              <div>
                <dt>{t('grantedBy')}</dt>
                <dd>{grant.grantedBy}</dd>
              </div>
              <div>
                <dt>{t('grantedAt')}</dt>
                <dd>{format(grant.grantedAt)}</dd>
              </div>
              <div>
                <dt>{t('expiresAt')}</dt>
                <dd>{format(grant.expiresAt)}</dd>
              </div>
              {grant.revokedAt ? (
                <div>
                  <dt>{t('revokedAt')}</dt>
                  <dd>{format(grant.revokedAt)}</dd>
                </div>
              ) : null}
              {grant.expiredAt ? (
                <div>
                  <dt>{t('expiredAt')}</dt>
                  <dd>{format(grant.expiredAt)}</dd>
                </div>
              ) : null}
            </dl>
            {grant.status === 'active' ? (
              <Button
                kind="danger--tertiary"
                disabled={busy !== null}
                onClick={() => void revoke(grant.id)}
              >
                {busy === grant.id ? t('revoking') : t('revoke')}
              </Button>
            ) : null}
            <h3>{t('usageHistory')}</h3>
            {grant.usage.length === 0 ? (
              <p>{t('noUsage')}</p>
            ) : (
              <ul className="kemfai-support-usage">
                {grant.usage.map((usage) => (
                  <li key={usage.id}>
                    <dl>
                      <div>
                        <dt>{t('usedBy')}</dt>
                        <dd>{usage.usedBy}</dd>
                      </div>
                      <div>
                        <dt>{t('action')}</dt>
                        <dd>{usage.actionSummary}</dd>
                      </div>
                      <div>
                        <dt>{t('attemptedAt')}</dt>
                        <dd>{format(usage.usedAt)}</dd>
                      </div>
                      <div>
                        <dt>{t('result')}</dt>
                        <dd>
                          {usage.wasDenied
                            ? t('denied', {
                                reason: t(`denialReasons.${usage.denialReason ?? 'unknown'}`),
                              })
                            : t('allowed')}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </Tile>
        ))}
      </section>
    </main>
  );
}
