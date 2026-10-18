'use client';

import { Link } from '@carbon/react';
import { useTranslations } from 'next-intl';

export function ChecklistNavigation() {
  const t = useTranslations('onboardingChecklist');
  return <nav className="kemfai-checklist-nav" aria-label={t('navigationLabel')} data-testid="checklist-navigation"><Link href="/checklist">{t('navigation')}</Link></nav>;
}
