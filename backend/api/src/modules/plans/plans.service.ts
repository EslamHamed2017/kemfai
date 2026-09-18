import { Injectable } from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { Plan } from '../entitlements/entities/plan.entity';
import { EntitlementsService } from '../entitlements/entitlements.service';

export interface PlanSummary {
  id: string;
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  features: string[];
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

    return Promise.all(
      plans.map(async (plan) => {
        const entitlementSet = await this.entitlementsService.getEntitlementSet(plan.id);
        return {
          id: plan.id,
          name: plan.name,
          monthlyPrice: Number(plan.monthlyPrice),
          annualPrice: Number(plan.annualPrice),
          currency: plan.currency,
          features: entitlementSet.features
            .filter((feature) => feature.enabled)
            .map((feature) => feature.key),
        };
      }),
    );
  }
}
