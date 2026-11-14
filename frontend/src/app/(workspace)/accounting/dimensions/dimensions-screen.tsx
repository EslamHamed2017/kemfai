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
type Versioned = { id: string; active: boolean; version: number };
type DimensionDefinition = Versioned & {
  key: string;
  kind: 'built_in' | 'custom' | 'tag';
  name: LocalizedName;
};
type DimensionValue = Versioned & {
  definitionId: string;
  code: string;
  name: LocalizedName;
};
type Requirement = 'required' | 'optional' | 'prohibited';
type DimensionRule = Versioned & {
  accountId?: string | null;
  transactionType?: string | null;
  dimensionDefinitionId: string;
  requirement: Requirement;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
};
type Account = Versioned & {
  code: string;
  name: LocalizedName;
  nodeKind: 'parent' | 'posting';
};
type Page<T> = { items: T[] };
type Editor =
  | { kind: 'value'; definitionId: string; code: string; nameEn: string; nameAr: string }
  | {
      kind: 'rule';
      definitionId: string;
      accountId: string;
      transactionType: string;
      requirement: Requirement;
      effectiveFrom: string;
      effectiveTo: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isLocalizedName(value: unknown): value is LocalizedName {
  return isRecord(value) && typeof value.en === 'string' && typeof value.ar === 'string';
}

function isVersioned(value: Record<string, unknown>): boolean {
  return typeof value.id === 'string' && typeof value.active === 'boolean' && Number.isSafeInteger(value.version);
}

function isDefinition(value: unknown): value is DimensionDefinition {
  return isRecord(value) && isVersioned(value) && typeof value.key === 'string' &&
    ['built_in', 'custom', 'tag'].includes(String(value.kind)) && isLocalizedName(value.name);
}

function isDimensionValue(value: unknown): value is DimensionValue {
  return isRecord(value) && isVersioned(value) && typeof value.definitionId === 'string' &&
    typeof value.code === 'string' && isLocalizedName(value.name);
}

function isRule(value: unknown): value is DimensionRule {
  return isRecord(value) && isVersioned(value) && typeof value.dimensionDefinitionId === 'string' &&
    ['required', 'optional', 'prohibited'].includes(String(value.requirement));
}

function isAccount(value: unknown): value is Account {
  return isRecord(value) && isVersioned(value) && typeof value.code === 'string' &&
    isLocalizedName(value.name) && (value.nodeKind === 'parent' || value.nodeKind === 'posting');
}

function page<T>(value: unknown, guard: (item: unknown) => item is T): Page<T> | null {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(guard)
    ? { items: value.items }
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

export function DimensionsScreen({ companyId }: { companyId?: string } = {}) {
  const t = useTranslations('accountingDimensions');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [definitions, setDefinitions] = useState<DimensionDefinition[]>([]);
  const [values, setValues] = useState<DimensionValue[]>([]);
  const [rules, setRules] = useState<DimensionRule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<'conflict' | 'general' | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const accountRef = useRef<HTMLSelectElement>(null);
  const valueCodeRef = useRef<HTMLInputElement>(null);

  const headers = useMemo<HeadersInit>(() => ({
    'accept-language': locale,
    ...(companyId ? { 'x-kemfai-company-id': companyId } : {}),
  }), [companyId, locale]);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setPhase('loading');
    try {
      const urls = [
        '/api/accounting/v1/dimension-definitions',
        '/api/accounting/v1/dimension-values',
        '/api/accounting/v1/dimension-rules',
        '/api/accounting/v1/accounts?active=true',
      ];
      const responses = await Promise.all(urls.map((url) => fetch(url, {
        cache: 'no-store', headers, signal: controller.signal,
      })));
      const bodies = await Promise.all(responses.map(readJson));
      if (controller.signal.aborted) return;
      const definitionPage = responses[0].ok ? page(bodies[0], isDefinition) : null;
      const valuePage = responses[1].ok ? page(bodies[1], isDimensionValue) : null;
      const rulePage = responses[2].ok ? page(bodies[2], isRule) : null;
      const accountPage = responses[3].ok ? page(bodies[3], isAccount) : null;
      if (!definitionPage || !valuePage || !rulePage || !accountPage) {
        setPhase('error');
        return;
      }
      setDefinitions(definitionPage.items);
      setValues(valuePage.items);
      setRules(rulePage.items);
      setAccounts(accountPage.items.filter(({ nodeKind, active }) => nodeKind === 'posting' && active));
      setExpanded(new Set());
      setPhase('ready');
    } catch {
      if (!controller.signal.aborted) setPhase('error');
    }
  }, [headers]);

  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
  }, [load]);

  useEffect(() => {
    if (editor?.kind === 'rule') accountRef.current?.focus();
    if (editor?.kind === 'value') valueCodeRef.current?.focus();
  }, [editor]);

  function toggleDefinition(id: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleOnKeyboard(event: KeyboardEvent<HTMLButtonElement>, id: string): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleDefinition(id);
    }
  }

  function openValue(): void {
    setMutationError(null);
    setEditor({ kind: 'value', definitionId: definitions[0]?.id ?? '', code: '', nameEn: '', nameAr: '' });
  }

  function openRule(): void {
    setMutationError(null);
    setEditor({
      kind: 'rule', definitionId: definitions[0]?.id ?? '', accountId: '', transactionType: '',
      requirement: 'optional', effectiveFrom: '', effectiveTo: '',
    });
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!editor || saving) return;
    setSaving(true);
    setMutationError(null);
    const isValue = editor.kind === 'value';
    const url = isValue
      ? '/api/accounting/v1/dimension-values'
      : '/api/accounting/v1/dimension-rules';
    const body = isValue
      ? { definitionId: editor.definitionId, code: editor.code.trim(), name: { en: editor.nameEn.trim(), ar: editor.nameAr.trim() } }
      : {
          dimensionDefinitionId: editor.definitionId,
          accountId: editor.accountId || null,
          transactionType: editor.transactionType.trim() || null,
          requirement: editor.requirement,
          effectiveFrom: editor.effectiveFrom || null,
          effectiveTo: editor.effectiveTo || null,
        };
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': operationKey(isValue ? 'dimension-value' : 'dimension-rule'),
        },
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      if (response.status === 409 || response.status === 412) {
        setMutationError('conflict');
        return;
      }
      if (!response.ok || !isRecord(payload)) {
        setMutationError('general');
        return;
      }
      if (isValue && isDimensionValue(payload.resource)) {
        setValues((current) => [...current, payload.resource as DimensionValue]);
      } else if (!isValue && isRule(payload.resource)) {
        setRules((current) => [...current, payload.resource as DimensionRule]);
      } else {
        setMutationError('general');
        return;
      }
      setEditor(null);
    } catch {
      setMutationError('general');
    } finally {
      setSaving(false);
    }
  }

  const empty = definitions.length === 0 && values.length === 0 && rules.length === 0;

  return (
    <main
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      data-testid={phase === 'ready' ? 'accounting-dimensions' : undefined}
      className="kemfai-accounting-surface"
      style={{ maxWidth: '72rem', marginInline: 'auto', padding: 'clamp(1rem, 4vw, 2rem)', minWidth: 0, overflowWrap: 'anywhere' }}
    >
      <h1>{t('title')}</h1>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
        <button type="button" data-testid="dimension-value-create" disabled={phase !== 'ready' || definitions.length === 0 || saving} onClick={openValue} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openValue(); } }}>
          {t('actions.createValue')}
        </button>
        <button type="button" data-testid="dimension-rule-create" disabled={phase !== 'ready' || definitions.length === 0 || saving} onClick={openRule}>
          {t('actions.createRule')}
        </button>
      </div>

      {phase === 'loading' && <p role="status" aria-live="polite" aria-busy="true">{t('loading')}</p>}
      {phase === 'error' && (
        <section role="alert" aria-live="assertive">
          <p>{t('errors.load')}</p>
          <button type="button" data-testid="accounting-dimensions-retry" onClick={() => void load()}>{t('actions.retry')}</button>
        </section>
      )}
      {phase === 'ready' && empty && <p data-testid="accounting-dimensions-empty">{t('empty')}</p>}

      {phase === 'ready' && definitions.length > 0 && (
        <table aria-label={t('tableLabel')} style={{ width: '100%', tableLayout: 'auto', marginBlockStart: '1rem' }}>
          <thead><tr><th scope="col">{t('columns.dimension')}</th><th scope="col">{t('columns.kind')}</th><th scope="col">{t('columns.values')}</th><th scope="col">{t('columns.rules')}</th></tr></thead>
          <tbody>
            {definitions.map((definition) => {
              const definitionValues = values.filter(({ definitionId }) => definitionId === definition.id);
              const definitionRules = rules.filter(({ dimensionDefinitionId }) => dimensionDefinitionId === definition.id);
              const isExpanded = expanded.has(definition.id);
              return (
                <tr key={definition.id}>
                  <th scope="row">
                    <button type="button" aria-expanded={isExpanded} aria-controls={`dimension-${definition.id}`} onClick={() => toggleDefinition(definition.id)} onKeyDown={(event) => toggleOnKeyboard(event, definition.id)}>
                      {definition.name[locale]}
                    </button>
                    {isExpanded && (
                      <section id={`dimension-${definition.id}`} role="region" aria-label={definition.name[locale]} style={{ paddingInlineStart: '1rem' }}>
                        <h2>{definition.name[locale]}</h2>
                        <ul aria-label={t('valuesLabel')}>
                          {definitionValues.map((value) => (
                            <li key={value.id} data-resource-id={value.id}>
                              {value.code} — <span data-resource-id={value.id}>{value.name[locale]}</span>{!value.active && ` — ${t('inactive')}`}
                            </li>
                          ))}
                        </ul>
                        <ul aria-label={t('rulesLabel')}>
                          {definitionRules.map((rule) => <li key={rule.id}>{rule.requirement}</li>)}
                        </ul>
                      </section>
                    )}
                  </th>
                  <td>{t(`kind.${definition.kind}`)}</td>
                  <td><ul aria-label={t('valuesLabel')}>{definitionValues.map((value) => <li key={value.id}><span data-resource-id={value.id}>{value.name[locale]}</span>{!value.active && ` — ${t('inactive')}`}</li>)}</ul></td>
                  <td>{definitionRules.length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {mutationError && <p role="alert" aria-live="assertive">{t(`errors.${mutationError}`)}</p>}
      {editor && (
        <section role="dialog" aria-modal="true" aria-labelledby="dimension-editor-title">
          <h2 id="dimension-editor-title">{t(editor.kind === 'rule' ? 'ruleEditor.title' : 'valueEditor.title')}</h2>
          <form onSubmit={(event) => void save(event)} style={{ display: 'grid', gap: '0.75rem', minWidth: 0 }}>
            <div><span aria-hidden="true">{t('fields.dimension')}</span>{' '}<select aria-label="Dimension" required value={editor.definitionId} onChange={(event) => setEditor({ ...editor, definitionId: event.target.value })}>
              {definitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.name[locale]}</option>)}
            </select></div>
            {editor.kind === 'value' ? <>
              <div><span aria-hidden="true">{t('fields.code')}</span>{' '}<input aria-label="Code" ref={valueCodeRef} required value={editor.code} onChange={(event) => setEditor({ ...editor, code: event.target.value })} /></div>
              <div><span aria-hidden="true">{t('fields.nameEn')}</span>{' '}<input aria-label="English name" required value={editor.nameEn} onChange={(event) => setEditor({ ...editor, nameEn: event.target.value })} /></div>
              <div><span aria-hidden="true">{t('fields.nameAr')}</span>{' '}<input aria-label="Arabic name" required dir="rtl" value={editor.nameAr} onChange={(event) => setEditor({ ...editor, nameAr: event.target.value })} /></div>
            </> : <>
              <div><span aria-hidden="true">{t('fields.account')}</span>{' '}<select ref={accountRef} aria-label="Account" value={editor.accountId} onChange={(event) => setEditor({ ...editor, accountId: event.target.value })}>
                <option value="">{t('fields.noAccount')}</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} — {account.name[locale]}</option>)}
              </select></div>
              <div><span aria-hidden="true">{t('fields.transactionType')}</span>{' '}<input aria-label="Transaction type" value={editor.transactionType} onChange={(event) => setEditor({ ...editor, transactionType: event.target.value })} /></div>
              <div><span aria-hidden="true">{t('fields.requirement')}</span>{' '}<select aria-label="Requirement" value={editor.requirement} onChange={(event) => setEditor({ ...editor, requirement: event.target.value as Requirement })}>
                <option value="optional">{t('requirement.optional')}</option>
                <option value="required">{t('requirement.required')}</option>
                <option value="prohibited">{t('requirement.prohibited')}</option>
              </select></div>
              <div><span aria-hidden="true">{t('fields.effectiveFrom')}</span>{' '}<input aria-label="Effective from" type="date" value={editor.effectiveFrom} onChange={(event) => setEditor({ ...editor, effectiveFrom: event.target.value })} /></div>
              <div><span aria-hidden="true">{t('fields.effectiveTo')}</span>{' '}<input aria-label="Effective to" type="date" value={editor.effectiveTo} onChange={(event) => setEditor({ ...editor, effectiveTo: event.target.value })} /></div>
            </>}
            <div>
              <button type="submit" disabled={saving}>{t(saving ? 'actions.saving' : 'actions.save')}</button>{' '}
              <button type="button" disabled={saving} onClick={() => setEditor(null)}>{t('actions.cancel')}</button>
            </div>
          </form>
        </section>
      )}
      <style jsx global>{`
        .kemfai-accounting-surface :where(button, input, select):focus-visible {
          outline: 0.1875rem solid #0f62fe;
          outline-offset: 0.125rem;
        }
        .kemfai-accounting-surface :where(button, input, select, table) { max-inline-size: 100%; }
        .kemfai-accounting-surface table { border-collapse: collapse; }
        .kemfai-accounting-surface :where(th, td) { padding: 0.5rem; text-align: start; vertical-align: top; }
      `}</style>
    </main>
  );
}
