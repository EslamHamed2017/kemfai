'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { SignOutButton } from '@/components/sign-out-button';

type State =
  | 'loading'
  | 'Pending'
  | 'Creating'
  | 'Ready'
  | 'Failed'
  | 'offline'
  | 'unavailable'
  | 'unauthorized'
  | 'unverified'
  | 'missing'
  | 'unknown';
const POLL_MS = 3000;

export function ProvisioningScreen({ supportEmail }: { supportEmail: string | null }) {
  const t = useTranslations('provisioning');
  const [state, setState] = useState<State>('loading');
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<'conflict' | 'service' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const stateRef = useRef<State>('loading');
  const update = useCallback((value: State) => {
    stateRef.current = value;
    setState(value);
  }, []);
  const poll = useCallback(async () => {
    if (!alive.current || busy.current || document.hidden) return;
    if (!navigator.onLine) {
      update('offline');
      return;
    }
    busy.current = true;
    const abort = new AbortController();
    controller.current = abort;
    try {
      const response = await fetch('/api/tenants/me', { cache: 'no-store', signal: abort.signal });
      if (!alive.current || abort.signal.aborted) return;
      if (response.status === 401) update('unauthorized');
      else if (response.status === 403) update('unverified');
      else if (response.status === 404) update('missing');
      else if (!response.ok) update('unavailable');
      else {
        const data: unknown = await response.json();
        const status = data && typeof data === 'object' && 'status' in data ? data.status : null;
        update(
          status === 'Pending' || status === 'Creating' || status === 'Ready' || status === 'Failed'
            ? status
            : 'unknown',
        );
        if (status !== 'Failed') setRetryError(null);
      }
    } catch {
      if (alive.current && !abort.signal.aborted)
        update(navigator.onLine ? 'unavailable' : 'offline');
    } finally {
      busy.current = false;
      controller.current = null;
      if (
        alive.current &&
        !['Ready', 'unauthorized', 'unverified', 'missing'].includes(stateRef.current)
      ) {
        timer.current = setTimeout(() => void poll(), POLL_MS);
      }
    }
  }, [update]);
  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!busy.current) void poll();
  }, [poll]);
  useEffect(() => {
    alive.current = true;
    void poll();
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', refresh);
    const onOffline = () => update('offline');
    window.addEventListener('offline', onOffline);
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      controller.current?.abort();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', onOffline);
    };
  }, [poll, refresh, update]);
  async function retry() {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const response = await fetch('/api/tenants/me/provisioning-retry', { method: 'POST' });
      if (response.status === 401) update('unauthorized');
      else if (response.status === 403) update('unverified');
      else if (response.status === 404) update('missing');
      else if (response.status === 202) {
        // An ordinary Failed retry returns Pending; the one exceptional case (a Ready
        // tenant repairing a missing Odoo company mapping) returns Ready. Apply ONLY
        // whichever of those two the body actually says — never assume Pending.
        let status: unknown;
        try {
          const data: unknown = await response.json();
          status =
            data && typeof data === 'object' && 'status' in data
              ? (data as { status: unknown }).status
              : null;
        } catch {
          status = null;
        }
        if (status === 'Pending' || status === 'Ready') {
          update(status);
          refresh();
        } else setRetryError('service');
      } else if (response.status === 409) {
        setRetryError('conflict');
        refresh();
      } else setRetryError('service');
    } catch {
      setRetryError('service');
    } finally {
      setRetrying(false);
    }
  }
  const inProgress = state === 'loading' || state === 'Pending' || state === 'Creating';
  const recoverable =
    state === 'Failed' || state === 'offline' || state === 'unavailable' || state === 'unknown';
  const supportSubject = encodeURIComponent('KEMFAI workspace provisioning assistance');
  return (
    <main
      style={{ maxWidth: 640, marginInline: 'auto', padding: '2rem', textAlign: 'start' }}
      aria-labelledby="provisioning-title"
    >
      <header>
        <LocaleSwitcher />
        <SignOutButton />
      </header>
      <h1 id="provisioning-title">{t('title')}</h1>
      {inProgress && (
        <section
          role="status"
          aria-live="polite"
          aria-busy="true"
          data-testid="provisioning-loading"
        >
          <h2>{t('settingUp')}</h2>
          <p>{t('waiting')}</p>
        </section>
      )}
      {state === 'Ready' && (
        <section role="status" data-testid="provisioning-ready">
          <h2>{t('ready.title')}</h2>
          <p>{t('ready.body')}</p>
          <Link href="/mfa">{t('ready.continue')}</Link>
        </section>
      )}
      {recoverable && (
        <section data-testid="provisioning-failure">
          <h2>{t(state === 'Failed' ? 'failed.title' : 'connection.title')}</h2>
          <p role="alert">
            {t(
              state === 'Failed'
                ? 'failed.body'
                : state === 'offline'
                  ? 'connection.offline'
                  : 'connection.body',
            )}
          </p>
          {state === 'Failed' && (
            <button
              type="button"
              disabled={retrying}
              onClick={() => void retry()}
              data-testid="provisioning-retry"
            >
              {t(retrying ? 'retrying' : 'retry')}
            </button>
          )}
          <button type="button" onClick={refresh} data-testid="provisioning-refresh">
            {t('checkAgain')}
          </button>
          {retryError && (
            <p role="alert">{t(retryError === 'conflict' ? 'conflict' : 'retryError')}</p>
          )}
          {supportEmail ? (
            <a
              data-testid="provisioning-support"
              href={`mailto:${supportEmail}?subject=${supportSubject}`}
            >
              {t('contactSupport')}
            </a>
          ) : (
            <p role="note">{t('supportUnavailable')}</p>
          )}
        </section>
      )}
      {(state === 'unauthorized' || state === 'unverified' || state === 'missing') && (
        <section role="alert">
          <h2>{t(`${state}.title`)}</h2>
          <p>{t(`${state}.body`)}</p>
          <Link href={state === 'unverified' ? '/verify' : '/auth/login?returnTo=%2Fprovisioning'}>
            {t(state === 'unverified' ? 'verify' : 'signIn')}
          </Link>
        </section>
      )}
    </main>
  );
}
