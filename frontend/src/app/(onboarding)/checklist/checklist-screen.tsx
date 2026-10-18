'use client';

import { Button, InlineLoading, InlineNotification, Link, Tag, Tile } from '@carbon/react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { SignOutButton } from '@/components/sign-out-button';
import { type ChecklistState, isChecklistState } from '@/lib/checklist-state';

type Phase = 'loading' | 'ready' | 'error' | 'session' | 'denied';
const POLL_MS = 3000;

export function ChecklistScreen({ initialState }: { initialState?: ChecklistState }) {
  const t = useTranslations('onboardingChecklist');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [phase, setPhase] = useState<Phase>(initialState ? 'ready' : 'loading');
  const [state, setState] = useState<ChecklistState | undefined>(initialState);

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setPhase('loading');
    try {
      const response = await fetch('/api/onboarding/checklist', { cache: 'no-store' });
      if (response.status === 401) return setPhase('session');
      if (response.status === 403 || response.status === 404) return setPhase('denied');
      const body: unknown = response.ok ? await response.json() : null;
      if (!isChecklistState(body)) return setPhase('error');
      setState(body);
      setPhase('ready');
    } catch {
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    if (!initialState) void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const refresh = () => void load();
    window.addEventListener('focus', refresh);
    window.addEventListener('kemfai:source-record-changed', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('kemfai:source-record-changed', refresh);
    };
  }, [initialState, load]);

  if (phase === 'denied') return null;
  const header = (
    <header className="kemfai-checklist-header">
      <LocaleSwitcher />
      <SignOutButton />
    </header>
  );
  if (phase !== 'ready' || !state)
    return (
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'} className="kemfai-checklist-shell">
        {header}
        <h1>{t('title')}</h1>
        {phase === 'loading' ? (
          <InlineLoading description={t('loading')} />
        ) : (
          <>
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title={t(phase === 'session' ? 'sessionExpired' : 'error')}
            />
            {phase === 'error' ? (
              <Button kind="ghost" size="sm" onClick={() => void load(true)}>
                {t('retry')}
              </Button>
            ) : null}
          </>
        )}
      </main>
    );

  const items = [
    { key: 'customer', done: state.customerAdded, href: '/modules#module.sales' },
    { key: 'bank', done: state.bankAdded, href: '/modules#module.accounting' },
    { key: 'product', done: state.productAdded, href: '/modules#module.inventory' },
    { key: 'firstInvoice', done: state.firstInvoiceReady, href: '/billing' },
  ] as const;
  const empty = !state.customerAdded && !state.bankAdded && !state.productAdded;
  return (
    <main dir={locale === 'ar' ? 'rtl' : 'ltr'} className="kemfai-checklist-shell">
      {header}
      <p className="kemfai-checklist-eyebrow">{t('eyebrow')}</p>
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>
      {empty ? (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title={t('empty')}
          data-testid="checklist-empty"
        />
      ) : null}
      {state.gatedOnSubscriptionActivation ? (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title={t('activationGate')}
          subtitle={t('activationHelp')}
          data-testid="activation-gate"
        />
      ) : (
        <InlineNotification
          kind="success"
          lowContrast
          hideCloseButton
          title={t('active')}
          data-testid="activation-active"
        />
      )}
      <section aria-label={t('listLabel')} className="kemfai-checklist-grid">
        {items.map((item) => (
          <Tile
            key={item.key}
            className="kemfai-checklist-item"
            data-testid={`checklist-${item.key}`}
          >
            <div>
              <h2>{t(`items.${item.key}.title`)}</h2>
              <p>{t(`items.${item.key}.description`)}</p>
            </div>
            <Tag type={item.done ? 'green' : 'gray'}>
              {item.done ? t('complete') : t('incomplete')}
            </Tag>
            <Link href={item.href}>{t(`items.${item.key}.action`)}</Link>
          </Tile>
        ))}
      </section>
      <p className="kemfai-checklist-live" aria-live="polite">
        {t('live')}
      </p>
    </main>
  );
}
