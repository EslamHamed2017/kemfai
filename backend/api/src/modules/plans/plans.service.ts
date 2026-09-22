import { Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import controlDataSource from '../../database/data-source';
import { Feature } from '../entitlements/entities/feature.entity';
import { Plan } from '../entitlements/entities/plan.entity';
import { EntitlementsService } from '../entitlements/entitlements.service';

export interface PlanSummary {
  id: string;
  name: LocalizedText;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  features: PlanFeatureSummary[];
}

export interface PlanFeatureSummary {
  key: string;
  name: LocalizedText;
  limitValue: number | null;
}

export interface LocalizedText {
  en: string;
  ar: string;
}

function translated(en: string | null, ar: string | null): en is string {
  return Boolean(en?.trim() && ar?.trim());
}

/**
 * Backs the public `GET /public/plans` catalog (T031, FR-016). Feature lists are sourced
 * exclusively through EntitlementsService's PlanFeatureEntitlement read (T010 acceptance
 * criteria) rather than a direct query, so this module never becomes a second place that
 * reads the entitlement tables.
 */
@Injectable()
export class PlansService {
  constructor(private readonly entitlementsService: EntitlementsService) {}

  async listPublishedPlans(): Promise<PlanSummary[]> {
    const planRepo = controlDataSource.getRepository(Plan);
    const plans = await planRepo.find({ where: { published: true }, order: { createdAt: 'ASC' } });

    const summaries = await Promise.all(
      plans.map(async (plan) => {
        if (!translated(plan.nameEn, plan.nameAr)) return null;
        const entitlementSet = await this.entitlementsService.getEntitlementSet(plan.id);
        const enabledEntitlements = entitlementSet.features.filter((feature) => feature.enabled);
        const enabledKeys = enabledEntitlements.map((feature) => feature.key);
        const features = enabledKeys.length
          ? await controlDataSource.getRepository(Feature).find({ where: { key: In(enabledKeys) } })
          : [];
        const byKey = new Map(features.map((feature) => [feature.key, feature]));
        const translatedFeatures = enabledEntitlements.map((entitlement) => ({
          entitlement,
          feature: byKey.get(entitlement.key),
        }));
        if (
          translatedFeatures.some(
            ({ feature }) => !feature || !translated(feature.displayNameEn, feature.displayNameAr),
          )
        ) {
          return null;
        }
        return {
          id: plan.id,
          name: { en: plan.nameEn!, ar: plan.nameAr! },
          monthlyPrice: Number(plan.monthlyPrice),
          annualPrice: Number(plan.annualPrice),
          currency: plan.currency,
          features: translatedFeatures.map(({ entitlement, feature }) => ({
            key: feature!.key,
            name: { en: feature!.displayNameEn!, ar: feature!.displayNameAr! },
            limitValue: entitlement.limitValue,
          })),
        };
      }),
    );
    return summaries.filter((summary): summary is PlanSummary => summary !== null);
  }
}
