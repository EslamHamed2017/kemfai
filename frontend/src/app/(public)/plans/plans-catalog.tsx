'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { getBrowserApiClient, type components } from '@/lib/api-client';

type PlanSummary = components['schemas']['PlanSummary'];
type BillingCycle = 'monthly' | 'annual';

export function PlansCatalog() {
  const t = useTranslations('plans');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [cycle, setCycle] = useState<BillingCycle>('monthly');

  const load = useCallback(async () => {
    setFailed(false);
    setPlans(null);
    try {
      const { data, error } = await getBrowserApiClient().GET('/public/plans');
      if (error || !data) throw new Error('Unable to load plans');
      setPlans(data);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>

      <fieldset>
        <legend>{t('billingCycle')}</legend>
        {(['monthly', 'annual'] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="billing-cycle"
              value={value}
              checked={cycle === value}
              onChange={() => setCycle(value)}
            />
            {t(value)}
          </label>
        ))}
      </fieldset>

      {plans === null && !failed ? (
        <p role="status" aria-live="polite">{t('loading')}</p>
      ) : null}
      {failed ? (
        <section role="alert">
          <p>{t('error')}</p>
          <button type="button" onClick={() => void load()}>{t('retry')}</button>
        </section>
      ) : null}
      {plans?.length === 0 ? <p role="status">{t('empty')}</p> : null}

      {plans?.map((plan) => {
        const price = cycle === 'monthly' ? plan.monthlyPrice : plan.annualPrice;
        return (
          <article key={plan.id} aria-labelledby={`plan-${plan.id}`}>
            <h2 id={`plan-${plan.id}`}>{plan.name[locale]}</h2>
            <p>
              {new Intl.NumberFormat(locale, {
                style: 'currency',
                currency: plan.currency,
              }).format(price)}{' '}
              / {t(cycle === 'monthly' ? 'month' : 'year')}
            </p>
            <h3>{t('features')}</h3>
            <ul>
              {plan.features.map((feature) => (
                <li key={feature.key}>
                  {feature.name[locale]}
                  {feature.limitValue !== null ? (
                    <>
                      {' — '}
                      {t('featureLimit', {
                        limit: new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en').format(
                          feature.limitValue,
                        ),
                      })}
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            <a href={`/signup?plan=${encodeURIComponent(plan.id)}&cycle=${cycle}`}>
              {t('choose', { plan: plan.name[locale] })}
            </a>
          </article>
        );
      })}
    </main>
  );
}
