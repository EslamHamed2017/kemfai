'use client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
export function SupportAccessNavigation() {
  const t = useTranslations('supportAccess');
  return (
    <nav
      className="kemfai-checklist-nav"
      aria-label={t('navigationLabel')}
      data-testid="support-access-navigation"
    >
      <Link href="/support-access">{t('navigation')}</Link>
    </nav>
  );
}
