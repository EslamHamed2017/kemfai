'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, InlineLoading, InlineNotification, Tag, Tile } from '@carbon/react';

import { LocaleSwitcher } from '@/components/locale-switcher';
import { SignOutButton } from '@/components/sign-out-button';
import type { ModuleOptionView } from '@/lib/auth/module-catalog';
import { MODULE_SELECTION_CHANGED } from './workspace-module-state';

type ModuleOption = ModuleOptionView;

type Phase = 'loading' | 'ready' | 'empty' | 'error' | 'session' | 'denied';

function validOption(value: unknown): value is ModuleOption {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const option = value as Record<string, unknown>;
  return (
    typeof option.key === 'string' &&
    typeof option.name === 'string' &&
    (typeof option.nameAr === 'string' || option.nameAr === null) &&
    typeof option.includedInCurrentPlan === 'boolean' &&
    typeof option.selected === 'boolean' &&
    (typeof option.requiredPlanTier === 'string' || option.requiredPlanTier === null)
  );
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

export function ModuleSelectionScreen({ initialOptions }: { initialOptions?: ModuleOption[] }) {
  const t = useTranslations('moduleSelection');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [phase, setPhase] = useState<Phase>(initialOptions?.length ? 'ready' : initialOptions ? 'empty' : 'loading');
  const [options, setOptions] = useState<ModuleOption[]>(initialOptions ?? []);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialOptions?.filter((option) => option.selected).map((option) => option.key) ?? []));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    setSaveError(null);
    try {
      const response = await fetch('/api/modules', { cache: 'no-store' });
      if (response.status === 404) return setPhase('denied');
      if (response.status === 401) return setPhase('session');
      if (!response.ok) return setPhase('error');
      const body = await json(response);
      if (!Array.isArray(body) || !body.every(validOption)) return setPhase('error');
      setOptions(body);
      const keys = body.filter((option) => option.selected).map((option) => option.key);
      setSelected(new Set(keys));
      window.dispatchEvent(new CustomEvent(MODULE_SELECTION_CHANGED, { detail: keys }));
      setPhase(body.length ? 'ready' : 'empty');
    } catch { setPhase('error'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (phase === 'denied') return null;

  const header = <header className="kemfai-module-header"><LocaleSwitcher /><SignOutButton /></header>;
  if (phase !== 'ready') {
    return <main dir={locale === 'ar' ? 'rtl' : 'ltr'} className="kemfai-module-shell">{header}<h1 className="kemfai-module-title">{t('title')}</h1>{phase === 'loading' ? <InlineLoading description={t('loading')} /> : phase === 'empty' ? <InlineNotification kind="info" lowContrast title={t('empty')} hideCloseButton /> : <><InlineNotification kind="error" lowContrast title={t(phase === 'session' ? 'sessionExpired' : 'loadError')} hideCloseButton />{phase === 'error' ? <Button size="sm" kind="ghost" onClick={() => void load()}>{t('retry')}</Button> : null}</>}</main>;
  }

  const label = (option: ModuleOption) => locale === 'ar' && option.nameAr ? option.nameAr : option.name;
  async function save() {
    if (saving) return;
    setSaving(true); setSaved(false); setSaveError(null);
    try {
      const response = await fetch('/api/modules/selection', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ featureKeys: [...selected].sort() }) });
      const body = await json(response);
      if (!response.ok) {
        const denied = body && typeof body === 'object' && Array.isArray((body as { featureKeys?: unknown }).featureKeys) ? (body as { featureKeys: string[] }).featureKeys : [];
        const deniedOption = options.find((option) => denied.includes(option.key));
        const plan = locale === 'ar'
          ? deniedOption?.requiredPlanTierAr ?? deniedOption?.requiredPlanTier
          : deniedOption?.requiredPlanTier;
        setSaveError(plan ? t('blocked', { plan }) : t('saveError'));
        return;
      }
      const keys = body && typeof body === 'object' && Array.isArray((body as { featureKeys?: unknown }).featureKeys) ? (body as { featureKeys: string[] }).featureKeys : [...selected];
      setSelected(new Set(keys));
      setOptions((current) => current.map((option) => ({ ...option, selected: keys.includes(option.key) })));
      window.dispatchEvent(new CustomEvent(MODULE_SELECTION_CHANGED, { detail: keys }));
      setSaved(true);
    } catch { setSaveError(t('saveError')); } finally { setSaving(false); }
  }

  return <main dir={locale === 'ar' ? 'rtl' : 'ltr'} className="kemfai-module-shell">
    {header}<h1 className="kemfai-module-title">{t('title')}</h1><p className="kemfai-module-intro">{t('intro')}</p>
    <fieldset disabled={saving} style={{ border: 0, padding: 0 }}><legend>{t('legend')}</legend>
      <div className="kemfai-module-grid">{options.map((option) => <Tile id={option.key} key={option.key} className="kemfai-module-card" data-included={option.includedInCurrentPlan}>
        <Checkbox id={`select-${option.key}`} labelText={label(option)} checked={selected.has(option.key)} disabled={!option.includedInCurrentPlan} onChange={(_event, data) => { const next = new Set(selected); if (data.checked) next.add(option.key); else next.delete(option.key); setSelected(next); setSaved(false); setSaveError(null); }} />
        <Tag type={option.includedInCurrentPlan ? 'purple' : 'gray'}>{option.includedInCurrentPlan ? t('included') : t('upgradeRequired')}</Tag>
        {!option.includedInCurrentPlan && <p id={`${option.key}-upgrade`} data-testid={`module-${option.key}-upgrade`}>{t('requiredPlan', { plan: locale === 'ar' ? option.requiredPlanTierAr ?? option.requiredPlanTier ?? t('unknownPlan') : option.requiredPlanTier ?? t('unknownPlan') })}</p>}
      </Tile>)}</div>
    </fieldset>
    {saveError && <InlineNotification kind="error" lowContrast title={saveError} hideCloseButton />}{saved && <InlineNotification kind="success" lowContrast title={t('saved')} hideCloseButton data-testid="module-selection-success" />}
    <div className="kemfai-module-actions"><Button data-testid="module-selection-save" disabled={saving} onClick={() => void save()}>{saving ? t('saving') : t('save')}</Button>{saving ? <InlineLoading description={t('saving')} /> : null}</div>
  </main>;
}
