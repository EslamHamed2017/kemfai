import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { findAvailableWorkspaceModule, loadModuleCatalog } from '@/lib/auth/module-catalog';

export default async function WorkspaceModulePage({ params }: { params: Promise<{ featureKey: string }> }) {
  if (!(await cookies()).get(SESSION_COOKIE)?.value) redirect('/auth/login');
  const { featureKey } = await params;
  const catalog = await loadModuleCatalog();
  if (catalog.status === 404) notFound();
  const option = findAvailableWorkspaceModule(catalog.options ?? [], featureKey);
  if (!option) notFound();
  const locale = (await getLocale()) === 'ar' ? 'ar' : 'en';
  const t = await getTranslations('moduleSelection');
  const name = locale === 'ar' && option.nameAr ? option.nameAr : option.name;
  return <main dir={locale === 'ar' ? 'rtl' : 'ltr'} style={{ maxWidth: 840, marginInline: 'auto', padding: '2rem' }}>
    <p style={{ color: '#525252', fontWeight: 600 }}>{t('workspaceModuleEyebrow')}</p>
    <h1>{name}</h1>
    <p role="status">{t('workspaceModuleReady')}</p>
    <Link href="/modules">{t('manageModules')}</Link>
  </main>;
}
