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
type Account = {
  id: string;
  code: string;
  name: LocalizedName;
  accountType: string;
  nodeKind: 'parent' | 'posting';
  parentId?: string | null;
  active: boolean;
  version: number;
  selectableForDraftLines?: boolean;
};
type AccountPage = { items: Account[]; nextCursor?: string | null };
type Editor = {
  mode: 'create' | 'edit';
  accountId?: string;
  code: string;
  nameEn: string;
  nameAr: string;
  accountType: string;
  nodeKind: 'parent' | 'posting';
  parentId: string;
  version?: number;
};

const EMPTY_EDITOR: Editor = {
  mode: 'create',
  code: '',
  nameEn: '',
  nameAr: '',
  accountType: '',
  nodeKind: 'posting',
  parentId: '',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAccount(value: unknown): value is Account {
  if (!isRecord(value) || !isRecord(value.name)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.code === 'string' &&
    typeof value.name.en === 'string' &&
    typeof value.name.ar === 'string' &&
    typeof value.accountType === 'string' &&
    (value.nodeKind === 'parent' || value.nodeKind === 'posting') &&
    (value.parentId === undefined || value.parentId === null || typeof value.parentId === 'string') &&
    typeof value.active === 'boolean' &&
    Number.isSafeInteger(value.version)
  );
}

function accountPage(value: unknown): AccountPage | null {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(isAccount)) return null;
  return { items: value.items, nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : null };
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

function replaceAccount(accounts: Account[], account: Account): Account[] {
  const index = accounts.findIndex(({ id }) => id === account.id);
  if (index === -1) return [...accounts, account];
  return accounts.map((current) => (current.id === account.id ? account : current));
}

export function ChartOfAccountsScreen({ companyId }: { companyId?: string } = {}) {
  const t = useTranslations('accountingCoa');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<'conflict' | 'general' | null>(null);
  const [success, setSuccess] = useState(false);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const editorOpenerRef = useRef<HTMLElement | null>(null);
  const pendingAccountFocusRef = useRef<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const nameEnRef = useRef<HTMLInputElement>(null);
  const mutationKey = useRef<string | null>(null);
  const loadController = useRef<AbortController | null>(null);

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
    try {
      const response = await fetch('/api/accounting/v1/accounts?active=true', {
        cache: 'no-store',
        headers: requestHeaders,
        signal: controller.signal,
      });
      const body = await readJson(response);
      if (controller.signal.aborted) return;
      const page = response.ok ? accountPage(body) : null;
      if (!page) {
        setPhase('error');
        return;
      }
      setAccounts(page.items);
      setExpanded(new Set(page.items.filter(({ nodeKind }) => nodeKind === 'parent').map(({ id }) => id)));
      setPhase('ready');
    } catch {
      if (!controller.signal.aborted) setPhase('error');
    }
  }, [requestHeaders]);

  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
  }, [load]);

  const children = useMemo(() => {
    const byParent = new Map<string | null, Account[]>();
    const ids = new Set(accounts.map(({ id }) => id));
    for (const account of accounts) {
      const parent = account.parentId && ids.has(account.parentId) ? account.parentId : null;
      byParent.set(parent, [...(byParent.get(parent) ?? []), account]);
    }
    for (const values of byParent.values()) values.sort((a, b) => a.code.localeCompare(b.code));
    return byParent;
  }, [accounts]);

  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    const visit = (parentId: string | null) => {
      for (const account of children.get(parentId) ?? []) {
        ids.push(account.id);
        if (account.nodeKind === 'parent' && expanded.has(account.id)) visit(account.id);
      }
    };
    visit(null);
    return ids;
  }, [children, expanded]);

  function focusAccount(id: string | undefined): void {
    if (id) itemRefs.current.get(id)?.focus();
  }

  function handleTreeKey(event: KeyboardEvent<HTMLLIElement>, account: Account): void {
    const index = visibleIds.indexOf(account.id);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusAccount(visibleIds[index + 1]);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusAccount(visibleIds[index - 1]);
    } else if (event.key === 'ArrowRight' && account.nodeKind === 'parent') {
      event.preventDefault();
      setExpanded((current) => new Set(current).add(account.id));
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (account.nodeKind === 'parent' && expanded.has(account.id)) {
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(account.id);
          return next;
        });
      } else focusAccount(account.parentId ?? undefined);
    } else if ((event.key === 'Enter' || event.key === ' ') && account.nodeKind === 'parent') {
      event.preventDefault();
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(account.id)) next.delete(account.id);
        else next.add(account.id);
        return next;
      });
    }
  }

  useEffect(() => {
    if (editor) codeRef.current?.focus();
  }, [editor]);

  useEffect(() => {
    if (editor || !pendingAccountFocusRef.current) return;
    const target = itemRefs.current.get(pendingAccountFocusRef.current);
    if (target) {
      target.focus();
      pendingAccountFocusRef.current = null;
    }
  }, [accounts, editor]);

  function rememberEditorOpener(): void {
    editorOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : createButtonRef.current;
  }

  function closeEditor(): void {
    const opener = editorOpenerRef.current;
    setEditor(null);
    opener?.focus();
  }

  function openCreate(): void {
    rememberEditorOpener();
    mutationKey.current = null;
    setMutationError(null);
    setSuccess(false);
    setEditor({ ...EMPTY_EDITOR });
  }

  function openEdit(account: Account): void {
    rememberEditorOpener();
    mutationKey.current = null;
    setMutationError(null);
    setSuccess(false);
    setEditor({
      mode: 'edit',
      accountId: account.id,
      code: account.code,
      nameEn: account.name.en,
      nameAr: account.name.ar,
      accountType: account.accountType,
      nodeKind: account.nodeKind,
      parentId: account.parentId ?? '',
      version: account.version,
    });
  }

  function changeEditor(change: Partial<Editor>): void {
    mutationKey.current = null;
    setMutationError(null);
    setSuccess(false);
    setEditor((current) => (current ? { ...current, ...change } : current));
  }

  async function mutate(
    url: string,
    method: 'POST' | 'PATCH',
    body: Record<string, unknown>,
    version?: number,
  ): Promise<Account | null> {
    const key = mutationKey.current ?? operationKey(`account-${method.toLowerCase()}`);
    mutationKey.current = key;
    const response = await fetch(url, {
      method,
      headers: {
        ...requestHeaders,
        'content-type': 'application/json',
        'idempotency-key': key,
        ...(version ? { 'if-match': `"${version}"` } : {}),
      },
      body: JSON.stringify(body),
    });
    const payload = await readJson(response);
    if (response.status === 412) {
      setMutationError('conflict');
      nameEnRef.current?.focus();
      return null;
    }
    if (!response.ok || !isRecord(payload) || !isAccount(payload.resource)) {
      setMutationError('general');
      return null;
    }
    mutationKey.current = null;
    return payload.resource;
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!editor || saving) return;
    setSaving(true);
    setMutationError(null);
    try {
      const body = {
        code: editor.code.trim(),
        name: { en: editor.nameEn.trim(), ar: editor.nameAr.trim() },
        accountType: editor.accountType.trim(),
        nodeKind: editor.nodeKind,
        parentId: editor.parentId || null,
      };
      const account = await mutate(
        editor.mode === 'create'
          ? '/api/accounting/v1/accounts'
          : `/api/accounting/v1/accounts/${encodeURIComponent(editor.accountId!)}`,
        editor.mode === 'create' ? 'POST' : 'PATCH',
        body,
        editor.version,
      );
      if (account) {
        pendingAccountFocusRef.current = account.id;
        setAccounts((current) => replaceAccount(current, account));
        if (account.parentId) setExpanded((current) => new Set(current).add(account.parentId!));
        setEditor(null);
        setSuccess(true);
      }
    } catch {
      setMutationError('general');
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(account: Account): Promise<void> {
    if (saving) return;
    mutationKey.current = null;
    setSaving(true);
    setMutationError(null);
    try {
      const updated = await mutate(
        `/api/accounting/v1/accounts/${encodeURIComponent(account.id)}`,
        'PATCH',
        { active: false },
        account.version,
      );
      if (updated) {
        const currentIndex = visibleIds.indexOf(account.id);
        pendingAccountFocusRef.current =
          account.parentId ?? visibleIds[currentIndex - 1] ?? visibleIds[currentIndex + 1] ?? null;
        setAccounts((current) => current.filter(({ id }) => id !== updated.id));
        setEditor(null);
        setSuccess(true);
      }
    } catch {
      setMutationError('general');
    } finally {
      setSaving(false);
    }
  }

  const renderBranch = (parentId: string | null, level: number): React.ReactNode =>
    (children.get(parentId) ?? []).map((account) => {
      const isParent = account.nodeKind === 'parent';
      const isExpanded = isParent && expanded.has(account.id);
      return (
        <li
          key={account.id}
          role="treeitem"
          aria-level={level}
          aria-selected={editor?.accountId === account.id}
          aria-label={`${account.code} ${account.name[locale]} ${t(`nodeKind.${account.nodeKind}`)}`}
          aria-expanded={isParent ? isExpanded : undefined}
          tabIndex={visibleIds[0] === account.id ? 0 : -1}
          data-account-id={account.id}
          ref={(node) => {
            if (node) itemRefs.current.set(account.id, node);
            else itemRefs.current.delete(account.id);
          }}
          onKeyDown={(event) => handleTreeKey(event, account)}
          style={{ minWidth: 0, paddingBlock: '0.375rem' }}
        >
          <span>{account.code} — {account.name[locale]} ({t(`nodeKind.${account.nodeKind}`)})</span>{' '}
          <button type="button" data-testid={`account-edit-${account.id}`} onClick={() => openEdit(account)}>
            {t('actions.edit')}
          </button>{' '}
          <button type="button" disabled={saving} onClick={() => void deactivate(account)}>
            {t('actions.deactivate')}
          </button>
          {isExpanded && (children.get(account.id)?.length ?? 0) > 0 && (
            <ul role="group" style={{ paddingInlineStart: '1.5rem' }}>
              {renderBranch(account.id, level + 1)}
            </ul>
          )}
        </li>
      );
    });

  return (
    <main
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      data-testid={phase === 'ready' ? 'accounting-coa' : undefined}
      className="kemfai-accounting-surface"
      style={{ width: '100%', maxWidth: '72rem', marginInline: 'auto', padding: 'clamp(1rem, 4vw, 2rem)', boxSizing: 'border-box', minWidth: 0, overflowWrap: 'anywhere' }}
    >
      <h1>{t('title')}</h1>
      <button ref={createButtonRef} type="button" data-testid="account-create" disabled={phase !== 'ready' || saving} onClick={openCreate}>
        {t('actions.create')}
      </button>

      {phase === 'loading' && <p role="status" aria-live="polite" aria-busy="true">{t('loading')}</p>}
      {phase === 'error' && (
        <section role="alert">
          <p>{t('errors.load')}</p>
          <button type="button" data-testid="accounting-coa-retry" onClick={() => void load()}>{t('actions.retry')}</button>
        </section>
      )}
      {phase === 'ready' && accounts.length === 0 && <p data-testid="accounting-coa-empty">{t('empty')}</p>}
      {phase === 'ready' && accounts.length > 0 && (
        <ul role="tree" aria-label={t('treeLabel')} dir={locale === 'ar' ? 'rtl' : 'ltr'} style={{ minWidth: 0 }}>
          {renderBranch(null, 1)}
        </ul>
      )}

      {success && <p role="status" aria-live="polite">{t('saved')}</p>}
      {mutationError && <p role="alert">{t(`errors.${mutationError}`)}</p>}

      {editor && (
        <form onSubmit={save} aria-label={t('formLabel')} style={{ display: 'grid', gap: '0.75rem', minWidth: 0 }}>
          <h2>{t(editor.mode === 'create' ? 'createTitle' : 'editTitle')}</h2>
          <label>{t('fields.code')}<input ref={codeRef} required value={editor.code} onChange={(e) => changeEditor({ code: e.target.value })} /></label>
          <label>{t('fields.nameEn')}<input ref={nameEnRef} required value={editor.nameEn} onChange={(e) => changeEditor({ nameEn: e.target.value })} /></label>
          <label>{t('fields.nameAr')}<input required dir="rtl" value={editor.nameAr} onChange={(e) => changeEditor({ nameAr: e.target.value })} /></label>
          <label>{t('fields.accountType')}<input required value={editor.accountType} onChange={(e) => changeEditor({ accountType: e.target.value })} /></label>
          <label>{t('fields.nodeKind')}
            <select value={editor.nodeKind} onChange={(e) => changeEditor({ nodeKind: e.target.value as 'parent' | 'posting' })}>
              <option value="parent">{t('nodeKind.parent')}</option>
              <option value="posting">{t('nodeKind.posting')}</option>
            </select>
          </label>
          <label>{t('fields.parent')}
            <select value={editor.parentId} onChange={(e) => changeEditor({ parentId: e.target.value })}>
              <option value="">{t('noParent')}</option>
              {accounts.filter(({ nodeKind, id }) => nodeKind === 'parent' && id !== editor.accountId).map((account) => (
                <option key={account.id} value={account.id}>{account.code} — {account.name[locale]}</option>
              ))}
            </select>
          </label>
          <div>
            <button type="submit" data-testid="account-save" disabled={saving}>{t(saving ? 'actions.saving' : 'actions.save')}</button>{' '}
            <button type="button" data-testid="account-editor-cancel" disabled={saving} onClick={closeEditor}>{t('actions.cancel')}</button>
          </div>
        </form>
      )}
      <style jsx global>{`
        .kemfai-accounting-surface :where(button, input, select, [role='treeitem']):focus-visible {
          outline: 0.1875rem solid #0f62fe;
          outline-offset: 0.125rem;
        }
        .kemfai-accounting-surface :where(button, input, select) {
          max-inline-size: 100%;
        }
      `}</style>
    </main>
  );
}
