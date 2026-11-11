'use client';

import { useLocale, useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

type LocalizedName = { en: string; ar: string };
type Journal = {
  id: string;
  code: string;
  name: LocalizedName;
  journalType: string;
  active: boolean;
  version: number;
};
type Currency = {
  currencyCode: string;
  enabled: boolean;
  isBase: boolean;
  nativeDecimalPlaces: number;
  nativeMetadataVersion: string;
  version: number;
};
type Editor = {
  mode: 'create' | 'edit';
  id?: string;
  code: string;
  nameEn: string;
  nameAr: string;
  journalType: string;
  active: boolean;
  version?: number;
};

const EMPTY_EDITOR: Editor = {
  mode: 'create',
  code: '',
  nameEn: '',
  nameAr: '',
  journalType: 'general',
  active: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isJournal(value: unknown): value is Journal {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.code === 'string' &&
    isRecord(value.name) &&
    typeof value.name.en === 'string' &&
    typeof value.name.ar === 'string' &&
    typeof value.journalType === 'string' &&
    typeof value.active === 'boolean' &&
    Number.isSafeInteger(value.version)
  );
}

function isCurrency(value: unknown): value is Currency {
  return (
    isRecord(value) &&
    typeof value.currencyCode === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.isBase === 'boolean' &&
    Number.isSafeInteger(value.nativeDecimalPlaces) &&
    typeof value.nativeMetadataVersion === 'string' &&
    Number.isSafeInteger(value.version)
  );
}

function pageItems<T>(value: unknown, predicate: (item: unknown) => item is T): T[] | null {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(predicate)
    ? value.items
    : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function operationKey(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function replaceBy<T>(items: T[], replacement: T, key: (item: T) => string): T[] {
  const wanted = key(replacement);
  return items.some((item) => key(item) === wanted)
    ? items.map((item) => (key(item) === wanted ? replacement : item))
    : [...items, replacement];
}

export function JournalsCurrenciesScreen({ companyId }: { companyId?: string } = {}) {
  const t = useTranslations('accounting');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [journals, setJournals] = useState<Journal[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<'saved' | 'staleConflict' | 'mutation' | null>(null);
  const usdCurrency = currencies.find(({ currencyCode }) => currencyCode === 'USD');
  const loadController = useRef<AbortController | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const editorOpener = useRef<HTMLElement | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const nameEnInput = useRef<HTMLInputElement>(null);
  const mutationKey = useRef<string | null>(null);

  const requestHeaders = useMemo<HeadersInit>(
    () => ({
      'accept-language': locale,
      ...(companyId ? { 'x-kemfai-company-id': companyId } : {}),
    }),
    [companyId, locale],
  );

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setPhase('loading');
    setMessage(null);
    try {
      const [journalsResponse, currenciesResponse] = await Promise.all([
        fetch('/api/accounting/v1/journals?includeInactive=true', {
          cache: 'no-store',
          headers: requestHeaders,
          signal: controller.signal,
        }),
        fetch('/api/accounting/v1/currencies', {
          cache: 'no-store',
          headers: requestHeaders,
          signal: controller.signal,
        }),
      ]);
      const [journalsBody, currenciesBody] = await Promise.all([
        readJson(journalsResponse),
        readJson(currenciesResponse),
      ]);
      if (controller.signal.aborted) return;
      const nextJournals = journalsResponse.ok ? pageItems(journalsBody, isJournal) : null;
      const nextCurrencies = currenciesResponse.ok ? pageItems(currenciesBody, isCurrency) : null;
      if (!nextJournals || !nextCurrencies) {
        setPhase('error');
        return;
      }
      setJournals(nextJournals);
      setCurrencies(nextCurrencies);
      setPhase('ready');
    } catch {
      if (!controller.signal.aborted) setPhase('error');
    }
  }, [requestHeaders]);

  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
  }, [load]);

  useEffect(() => {
    if (editor) codeInput.current?.focus();
  }, [editor]);

  function rememberOpener(): void {
    editorOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : createButton.current;
  }

  function openCreate(): void {
    rememberOpener();
    mutationKey.current = null;
    setMessage(null);
    setEditor({ ...EMPTY_EDITOR });
  }

  function openEdit(journal: Journal): void {
    rememberOpener();
    mutationKey.current = null;
    setMessage(null);
    setEditor({
      mode: 'edit',
      id: journal.id,
      code: journal.code,
      nameEn: journal.name.en,
      nameAr: journal.name.ar,
      journalType: journal.journalType,
      active: journal.active,
      version: journal.version,
    });
  }

  function closeEditor(): void {
    const opener = editorOpener.current;
    setEditor(null);
    opener?.focus();
  }

  function changeEditor(change: Partial<Editor>): void {
    mutationKey.current = null;
    setMessage(null);
    setEditor((current) => (current ? { ...current, ...change } : current));
  }

  async function saveJournal(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!editor || saving) return;
    setSaving(true);
    setMessage(null);
    const key = mutationKey.current ?? operationKey('journal');
    mutationKey.current = key;
    try {
      const response = await fetch(
        editor.mode === 'create'
          ? '/api/accounting/v1/journals'
          : `/api/accounting/v1/journals/${encodeURIComponent(editor.id!)}`,
        {
          method: editor.mode === 'create' ? 'POST' : 'PATCH',
          headers: {
            ...requestHeaders,
            'content-type': 'application/json',
            'idempotency-key': key,
            ...(editor.mode === 'edit' ? { 'if-match': `"${editor.version}"` } : {}),
          },
          body: JSON.stringify({
            code: editor.code.trim(),
            name: { en: editor.nameEn.trim(), ar: editor.nameAr.trim() },
            journalType: editor.journalType,
            active: editor.active,
          }),
        },
      );
      const body = await readJson(response);
      if (response.status === 412) {
        setMessage('staleConflict');
        nameEnInput.current?.focus();
        return;
      }
      if (!response.ok || !isRecord(body) || !isJournal(body.resource)) {
        setMessage('mutation');
        return;
      }
      mutationKey.current = null;
      setJournals((current) => replaceBy(current, body.resource as Journal, ({ id }) => id));
      setEditor(null);
      setMessage('saved');
      editorOpener.current?.focus();
    } catch {
      setMessage('mutation');
    } finally {
      setSaving(false);
    }
  }

  async function toggleCurrency(currency: Currency): Promise<void> {
    if (saving || currency.isBase) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/accounting/v1/currencies/${encodeURIComponent(currency.currencyCode)}`,
        {
          method: 'PUT',
          headers: {
            ...requestHeaders,
            'content-type': 'application/json',
            'idempotency-key': operationKey('currency'),
            'if-match': Number.isSafeInteger(currency.version) ? `"${currency.version}"` : '*',
          },
          body: JSON.stringify({ enabled: !currency.enabled }),
        },
      );
      const body = await readJson(response);
      if (response.status === 412) {
        setMessage('staleConflict');
        return;
      }
      if (!response.ok || !isRecord(body) || !isCurrency(body.resource)) {
        setMessage('mutation');
        return;
      }
      setCurrencies((current) =>
        replaceBy(current, body.resource as Currency, ({ currencyCode }) => currencyCode),
      );
      setMessage('saved');
    } catch {
      setMessage('mutation');
    } finally {
      setSaving(false);
    }
  }

  function createKey(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openCreate();
    }
  }

  return (
    <main
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      data-testid={phase === 'ready' ? 'accounting-journals-currencies' : undefined}
      style={{
        width: '100%',
        maxWidth: '72rem',
        marginInline: 'auto',
        padding: 'clamp(1rem, 4vw, 2rem)',
        boxSizing: 'border-box',
        minWidth: 0,
        overflowWrap: 'anywhere',
      }}
    >
      <h1>{t('title')}</h1>
      <button
        ref={createButton}
        type="button"
        data-testid="journal-create"
        disabled={phase !== 'ready' || saving}
        onClick={openCreate}
        onKeyDown={createKey}
      >
        {t('actions.createJournal')}
      </button>
      {(phase === 'loading' || usdCurrency) && (
        <button
          type="button"
          data-testid="currency-enable-USD"
          disabled={phase !== 'ready' || saving || !usdCurrency || usdCurrency.isBase}
          hidden={phase === 'loading'}
          onClick={() => usdCurrency && void toggleCurrency(usdCurrency)}
        >
          {t(usdCurrency?.enabled ? 'actions.disableCurrency' : 'actions.enableCurrency')}
        </button>
      )}

      {phase === 'loading' && (
        <section aria-busy="true">
          <p role="status" aria-live="polite">
            {t('loading')}
          </p>
        </section>
      )}
      {phase === 'error' && (
        <section role="alert" aria-live="assertive">
          <p>{t('errors.load')}</p>
          <button type="button" data-testid="journals-currencies-retry" onClick={() => void load()}>
            {t('actions.retry')}
          </button>
        </section>
      )}

      {phase === 'ready' && (
        <>
          <section aria-labelledby="journals-heading">
            <h2 id="journals-heading">{t('journals.title')}</h2>
            {journals.length === 0 ? (
              <p data-testid="accounting-journals-empty">{t('journals.empty')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table aria-label={t('journals.tableLabel')}>
                  <thead>
                    <tr>
                      <th>{t('fields.code')}</th>
                      <th>{t('fields.name')}</th>
                      <th>{t('fields.type')}</th>
                      <th>{t('fields.status')}</th>
                      <th>{t('fields.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {journals.map((journal) => (
                      <tr
                        key={journal.id}
                        data-resource-id={journal.id}
                        data-active={journal.active ? 'true' : undefined}
                        data-historical={!journal.active ? 'true' : undefined}
                      >
                        <td>{journal.code}</td>
                        <td>{journal.name[locale]}</td>
                        <td>{journal.journalType}</td>
                        <td>{t(journal.active ? 'status.active' : 'status.inactive')}</td>
                        <td>
                          <button
                            type="button"
                            data-testid={`journal-edit-${journal.id}`}
                            disabled={saving}
                            onClick={() => openEdit(journal)}
                          >
                            {t('actions.edit')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="currencies-heading">
            <h2 id="currencies-heading">{t('currencies.title')}</h2>
            {currencies.length === 0 ? (
              <p data-testid="accounting-currencies-empty">{t('currencies.empty')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table aria-label={t('currencies.tableLabel')}>
                  <thead>
                    <tr>
                      <th>{t('fields.currency')}</th>
                      <th>{t('fields.enabled')}</th>
                      <th>{t('fields.base')}</th>
                      <th>{t('fields.nativeDecimalPlaces')}</th>
                      <th>{t('fields.nativeMetadataVersion')}</th>
                      <th>{t('fields.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currencies.map((currency) => (
                      <tr key={currency.currencyCode}>
                        <td>
                          <span data-currency-code={currency.currencyCode}>
                            {currency.currencyCode}
                          </span>
                        </td>
                        <td>{t(currency.enabled ? 'status.enabled' : 'status.disabled')}</td>
                        <td>{currency.isBase ? t('status.base') : t('status.nonBase')}</td>
                        <td>{currency.nativeDecimalPlaces}</td>
                        <td>{currency.nativeMetadataVersion}</td>
                        <td>
                          <button
                            type="button"
                            data-testid={
                              currency.currencyCode === 'USD'
                                ? undefined
                                : `currency-enable-${currency.currencyCode}`
                            }
                            disabled={saving || currency.isBase}
                            onClick={() => void toggleCurrency(currency)}
                          >
                            {t(
                              currency.enabled
                                ? 'actions.disableCurrency'
                                : 'actions.enableCurrency',
                            )}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {message === 'saved' && (
        <p role="status" aria-live="polite">
          {t('saved')}
        </p>
      )}
      {(message === 'staleConflict' || message === 'mutation') && (
        <p role="alert" aria-live="assertive">
          {t(`errors.${message}`)}
        </p>
      )}

      {editor && (
        <div role="dialog" aria-modal="true" aria-label={t('journalDialogLabel')}>
          <form onSubmit={saveJournal} style={{ display: 'grid', gap: '0.75rem', minWidth: 0 }}>
            <h2>{t(editor.mode === 'create' ? 'journalCreateTitle' : 'journalEditTitle')}</h2>
            <label>
              {t('fields.code')}
              <input
                ref={codeInput}
                required
                value={editor.code}
                onChange={(event) => changeEditor({ code: event.target.value })}
              />
            </label>
            <label>
              {t('fields.nameEn')}
              <input
                ref={nameEnInput}
                required
                value={editor.nameEn}
                onChange={(event) => changeEditor({ nameEn: event.target.value })}
              />
            </label>
            <label>
              {t('fields.nameAr')}
              <input
                required
                dir="rtl"
                value={editor.nameAr}
                onChange={(event) => changeEditor({ nameAr: event.target.value })}
              />
            </label>
            <label>
              {t('fields.type')}
              <input
                required
                value={editor.journalType}
                onChange={(event) => changeEditor({ journalType: event.target.value })}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={editor.active}
                onChange={(event) => changeEditor({ active: event.target.checked })}
              />
              {t('fields.active')}
            </label>
            <div>
              <button type="submit" data-testid="journal-save" disabled={saving}>
                {t('actions.save')}
              </button>{' '}
              <button type="button" disabled={saving} onClick={closeEditor}>
                {t('actions.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}
      <style jsx global>{`
        [data-testid='accounting-journals-currencies'] :where(button, input):focus-visible {
          outline: 0.1875rem solid #0f62fe;
          outline-offset: 0.125rem;
        }
        [data-testid='accounting-journals-currencies'] :where(button, input, table) {
          max-inline-size: 100%;
        }
      `}</style>
    </main>
  );
}
