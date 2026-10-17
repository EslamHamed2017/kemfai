'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import type { ModuleOptionView } from '@/lib/auth/module-catalog';

export const MODULE_SELECTION_CHANGED = 'kemfai:module-selection-changed';

export function WorkspaceModuleState({ options }: { options: ModuleOptionView[] }) {
  const t = useTranslations('moduleSelection');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const entitled = useMemo(
    () => new Set(options.filter((option) => option.includedInCurrentPlan).map((option) => option.key)),
    [options],
  );
  const [selected, setSelected] = useState(() => new Set(options.filter((option) => option.selected && option.includedInCurrentPlan).map((option) => option.key)));
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (Array.isArray(detail) && detail.every((key) => typeof key === 'string')) {
        setSelected(new Set(detail.filter((key) => entitled.has(key))));
      }
    };
    window.addEventListener(MODULE_SELECTION_CHANGED, update);
    return () => window.removeEventListener(MODULE_SELECTION_CHANGED, update);
  }, [entitled]);
  const active = options.filter((option) => option.includedInCurrentPlan && selected.has(option.key));
  const label = (option: ModuleOptionView) => locale === 'ar' && option.nameAr ? option.nameAr : option.name;
  return <aside className="kemfai-workspace-state">
    <nav aria-label={t('navigationTitle')} data-testid="workspace-module-navigation">
      <h2>{t('navigationTitle')}</h2>
      {active.length ? <ul className="kemfai-workspace-links">{active.map((option) => <li key={option.key}><Link className="kemfai-workspace-link" href={`/workspace/modules/${encodeURIComponent(option.key)}`}>{label(option)}</Link></li>)}</ul> : <p>{t('navigationEmpty')}</p>}
    </nav>
    <section data-testid="workspace-module-checklist"><p role="status">{t('checklistReflection', { count: active.length })}</p>{active.length ? <ul>{active.map((option) => <li key={option.key}>{label(option)} — {t('enabledStatus')}</li>)}</ul> : null}</section>
  </aside>;
}
