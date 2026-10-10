'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { LocaleSwitcher } from '@/components/locale-switcher';
import { SignOutButton } from '@/components/sign-out-button';
import type { components } from '@/lib/api-client';
import {
  ACCOUNTING_SETUP_TEMPLATE_OPTIONS,
  WIZARD_STEPS,
  type StepField,
} from '../setup-wizard/steps';
import {
  classifySetupWizardError,
  type SetupWizardFieldErrorKind,
} from '../setup-wizard/setup-wizard-error';

type CompanySettingsView = components['schemas']['CompanySettingsView'];

type Phase =
  | 'loading'
  | 'active'
  | 'sessionExpired'
  | 'setupIncomplete'
  | 'featureUnavailable'
  | 'forbiddenRole'
  | 'trialExpired'
  | 'offline'
  | 'unavailable';

const ALL_FIELDS = WIZARD_STEPS.flatMap((step) => step.fields);

function isCompanySettingsView(body: unknown): body is Required<CompanySettingsView> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const view = body as Record<string, unknown>;
  return (
    view.setupComplete === true &&
    typeof view.values === 'object' &&
    view.values !== null &&
    !Array.isArray(view.values)
  );
}

function normalizeValues(raw: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of ALL_FIELDS) {
    const value = raw[field.key];
    result[field.key] =
      value === null || value === undefined || value === false ? '' : String(value);
  }
  return result;
}

function toPayloadValue(field: StepField, raw: string): string | number {
  const trimmed = raw.trim();
  if (field.kind !== 'integer') return trimmed;
  if (trimmed === '') return '';
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? trimmed : parsed;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(body: unknown): unknown {
  return body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
}

function isSetupIncomplete(body: unknown): boolean {
  return (
    !!body &&
    typeof body === 'object' &&
    (body as { statusCode?: unknown }).statusCode === 409 &&
    (body as { setupComplete?: unknown }).setupComplete === false
  );
}

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `company-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function CompanySettingsScreen() {
  const t = useTranslations('companySettings');
  const setup = useTranslations('setupWizard');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [phase, setPhase] = useState<Phase>('loading');
  const [values, setValues] = useState<Record<string, string>>({});
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fieldError, setFieldError] = useState<SetupWizardFieldErrorKind | null>(null);
  const [configGap, setConfigGap] = useState(false);
  const [generalError, setGeneralError] = useState(false);
  const loadController = useRef<AbortController | null>(null);
  const saveController = useRef<AbortController | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  const applyRequestError = useCallback((status: number, body: unknown): void => {
    if (status === 409 && isSetupIncomplete(body)) {
      setPhase('setupIncomplete');
      return;
    }
    const kind = classifySetupWizardError(status, errorMessage(body));
    if (kind.kind === 'sessionExpired') setPhase('sessionExpired');
    else if (kind.kind === 'featureUnavailable') setPhase('featureUnavailable');
    else if (kind.kind === 'forbiddenRole') setPhase('forbiddenRole');
    else if (kind.kind === 'trialExpired') setPhase('trialExpired');
    else if (kind.kind === 'field') setFieldError(kind.field);
    else if (kind.kind === 'configGap') setConfigGap(true);
    else setGeneralError(true);
  }, []);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setPhase('loading');
    setGeneralError(false);
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setPhase('offline');
      return;
    }
    try {
      const response = await fetch('/api/companies/current/settings', {
        cache: 'no-store',
        signal: controller.signal,
      });
      const body = await readJson(response);
      if (controller.signal.aborted) return;
      if (!response.ok) {
        applyRequestError(response.status, body);
        if (![401, 403, 404, 409].includes(response.status)) setPhase('unavailable');
        return;
      }
      if (!isCompanySettingsView(body)) {
        setPhase('unavailable');
        return;
      }
      setValues(normalizeValues(body.values));
      setDirtyKeys(new Set());
      setPhase('active');
    } catch {
      if (controller.signal.aborted) return;
      setPhase(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'unavailable');
    }
  }, [applyRequestError]);

  useEffect(() => {
    void load();
    return () => {
      loadController.current?.abort();
      saveController.current?.abort();
    };
  }, [load]);

  function setFieldValue(key: string, value: string): void {
    setValues((previous) => ({ ...previous, [key]: value }));
    setDirtyKeys((previous) => new Set(previous).add(key));
    // A retry of the same logical edit keeps its key after an ambiguous network/5xx
    // outcome. Once the user changes the payload, it is a new edit and must receive a
    // new key or the API will correctly reject the changed fingerprint with 409.
    idempotencyKey.current = null;
    setSaved(false);
    if (fieldError === key) setFieldError(null);
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaved(false);
    setFieldError(null);
    setConfigGap(false);
    setGeneralError(false);
    const controller = new AbortController();
    saveController.current = controller;
    const key = idempotencyKey.current ?? createIdempotencyKey();
    idempotencyKey.current = key;
    const payload: Record<string, string | number> = {};
    // The endpoint accepts partial values. Sending only fields edited in this tab
    // prevents a stale form from reverting unrelated fields another tab saved after
    // this one loaded.
    for (const field of ALL_FIELDS) {
      if (dirtyKeys.has(field.key)) {
        payload[field.key] = toPayloadValue(field, values[field.key] ?? '');
      }
    }

    try {
      const response = await fetch('/api/companies/current/settings', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify({ values: payload }),
        signal: controller.signal,
      });
      const body = await readJson(response);
      if (controller.signal.aborted) return;
      if (response.ok) {
        if (isCompanySettingsView(body)) {
          setValues(normalizeValues(body.values));
        } else {
          // OpenAPI permits a body-less 200 even though T106 currently returns a view.
          // Keep the clean form aligned with what this client actually submitted in
          // either case (including trimming and numeric conversion).
          setValues((previous) => ({
            ...previous,
            ...Object.fromEntries(
              Object.entries(payload).map(([field, value]) => [field, String(value)]),
            ),
          }));
        }
        idempotencyKey.current = null;
        setDirtyKeys(new Set());
        setSaved(true);
        return;
      }
      if ([400, 401, 403, 404, 409, 422].includes(response.status)) {
        idempotencyKey.current = null;
      }
      applyRequestError(response.status, body);
    } catch {
      if (!controller.signal.aborted) setGeneralError(true);
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  const shellStyle = {
    width: '100%',
    maxWidth: 760,
    marginInline: 'auto',
    padding: '2rem',
    boxSizing: 'border-box' as const,
    textAlign: 'start' as const,
  };

  const header = (
    <header style={{ display: 'flex', gap: '1rem', justifyContent: 'space-between' }}>
      <LocaleSwitcher />
      <SignOutButton />
    </header>
  );

  if (phase === 'loading') {
    return (
      <main
        dir={locale === 'ar' ? 'rtl' : 'ltr'}
        style={shellStyle}
        aria-labelledby="company-settings-title"
      >
        {header}
        <h1 id="company-settings-title">{t('title')}</h1>
        <section
          role="status"
          aria-live="polite"
          aria-busy="true"
          data-testid="company-settings-loading"
        >
          {t('loading')}
        </section>
      </main>
    );
  }

  if (phase === 'setupIncomplete') {
    return (
      <main
        dir={locale === 'ar' ? 'rtl' : 'ltr'}
        style={shellStyle}
        data-testid="company-settings-setup-incomplete"
      >
        {header}
        <h1>{t('title')}</h1>
        <section role="alert">
          <p>{t('errors.setupIncomplete')}</p>
          <Link href="/setup-wizard">{t('actions.openWizard')}</Link>
        </section>
      </main>
    );
  }

  if (phase === 'sessionExpired') {
    return (
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'} style={shellStyle}>
        {header}
        <section role="alert">
          <h1>{t('errors.sessionExpired')}</h1>
          <Link href="/auth/login?returnTo=%2Fcompany-settings">{t('actions.signIn')}</Link>
        </section>
      </main>
    );
  }

  if (phase === 'featureUnavailable' || phase === 'forbiddenRole' || phase === 'trialExpired') {
    const errorKey =
      phase === 'featureUnavailable'
        ? 'featureUnavailable'
        : phase === 'forbiddenRole'
          ? 'forbiddenRole'
          : 'trialExpired';
    return (
      <main dir={locale === 'ar' ? 'rtl' : 'ltr'} style={shellStyle}>
        {header}
        <section role="alert">
          <h1>{t(`errors.${errorKey}`)}</h1>
        </section>
      </main>
    );
  }

  if (phase === 'offline' || phase === 'unavailable') {
    return (
      <main
        dir={locale === 'ar' ? 'rtl' : 'ltr'}
        style={shellStyle}
        data-testid="company-settings-recoverable"
      >
        {header}
        <section role="alert">
          <h1>{t(phase === 'offline' ? 'errors.offline' : 'errors.unavailable')}</h1>
          <button type="button" onClick={() => void load()}>
            {t('actions.retry')}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      style={shellStyle}
      aria-labelledby="company-settings-title"
      data-testid="company-settings"
    >
      {header}
      <h1 id="company-settings-title">{t('title')}</h1>
      <p>{t('intro')}</p>
      {saved && (
        <p role="status" aria-live="polite" data-testid="company-settings-saved">
          {t('saved')}
        </p>
      )}
      {generalError && (
        <p role="alert" data-testid="company-settings-general-error">
          {t('errors.general')}
        </p>
      )}
      {configGap && (
        <p role="alert" data-testid="company-settings-config-gap">
          {t('errors.configGap')}
        </p>
      )}

      <form
        aria-label={t('formLabel')}
        onSubmit={save}
        noValidate
        style={{ display: 'grid', gap: '1.5rem', minWidth: 0 }}
      >
        {WIZARD_STEPS.map((step) => (
          <fieldset
            key={step.id}
            disabled={saving}
            style={{ display: 'grid', gap: '1rem', minWidth: 0 }}
          >
            <legend>{setup(`steps.${step.id}`)}</legend>
            {step.fields.map((field) => {
              const fieldId = `company-settings-${field.key}`;
              const hasError = fieldError === field.key;
              return (
                <div key={field.key}>
                  <label htmlFor={fieldId} style={{ display: 'block' }}>
                    {setup(`fields.${field.key}.label`)}
                  </label>
                  {field.kind === 'month-select' && (
                    <select
                      id={fieldId}
                      value={values[field.key] ?? ''}
                      aria-invalid={hasError}
                      aria-describedby={hasError ? `${fieldId}-error` : undefined}
                      onChange={(event) => setFieldValue(field.key, event.target.value)}
                    >
                      <option value="">{setup('fields.selectPlaceholder')}</option>
                      {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                        <option key={month} value={String(month)}>
                          {month}
                        </option>
                      ))}
                    </select>
                  )}
                  {field.kind === 'template-select' && (
                    <select
                      id={fieldId}
                      value={values[field.key] ?? ''}
                      aria-invalid={hasError}
                      aria-describedby={hasError ? `${fieldId}-error` : undefined}
                      onChange={(event) => setFieldValue(field.key, event.target.value)}
                    >
                      <option value="">{setup('fields.selectPlaceholder')}</option>
                      {ACCOUNTING_SETUP_TEMPLATE_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {setup(`fields.accounting_setup_template.options.${option}`)}
                        </option>
                      ))}
                    </select>
                  )}
                  {(field.kind === 'text' || field.kind === 'integer') && (
                    <input
                      id={fieldId}
                      type={field.kind === 'integer' ? 'number' : 'text'}
                      value={values[field.key] ?? ''}
                      aria-invalid={hasError}
                      aria-describedby={hasError ? `${fieldId}-error` : undefined}
                      onChange={(event) => setFieldValue(field.key, event.target.value)}
                    />
                  )}
                  {hasError && (
                    <p role="alert" id={`${fieldId}-error`}>
                      {setup(`fields.${field.key}.error`)}
                    </p>
                  )}
                </div>
              );
            })}
          </fieldset>
        ))}
        <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
          <button
            type="submit"
            disabled={saving || dirtyKeys.size === 0}
            data-testid="company-settings-save"
            style={{ minInlineSize: '9rem' }}
          >
            {t(saving ? 'actions.saving' : 'actions.save')}
          </button>
        </div>
      </form>
    </main>
  );
}
