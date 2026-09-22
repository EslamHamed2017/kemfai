import { getTranslations } from 'next-intl/server';

export default async function PlansLoading() {
  const t = await getTranslations('plans');
  return (
    <main aria-busy="true" aria-live="polite">
      <p>{t('loading')}</p>
    </main>
  );
}
