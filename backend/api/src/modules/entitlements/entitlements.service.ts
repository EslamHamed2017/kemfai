import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { Account } from '../accounts/entities/account.entity';
import { EntitlementDefault } from './entities/entitlement-default.entity';
import { FeatureFlag } from './entities/feature-flag.entity';
import { PlanFeatureEntitlement } from './entities/plan-feature-entitlement.entity';
import { PlanSetting } from './entities/plan-setting.entity';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EntitlementSetFeature {
  key: string;
  enabled: boolean;
  limitValue: number | null;
}

export interface EntitlementSetFeatureFlag {
  key: string;
  enabled: boolean;
}

export interface EntitlementSet {
  planId: string;
  features: EntitlementSetFeature[];
  trialWindowDays: number;
  autoRestrictUnpaid: boolean;
  featureFlags: EntitlementSetFeatureFlag[];
}

/**
 * The only service permitted to read PlanFeatureEntitlement/PlanSetting/EntitlementDefault
 * (T010 acceptance criteria, FR-030/FR-030a) and FeatureFlag (T099 acceptance criteria, Constitution
 * Principle VI) — every later module-selection, checklist-gating, trial/auto-restriction, or
 * module-completeness check must call this instead of querying those tables directly.
 */
@Injectable()
export class EntitlementsService {
  async getEntitlementSet(planId: string): Promise<EntitlementSet> {
    const entitlementRepo = controlDataSource.getRepository(PlanFeatureEntitlement);
    const settingRepo = controlDataSource.getRepository(PlanSetting);
    const defaultRepo = controlDataSource.getRepository(EntitlementDefault);

    const [entitlements, setting, defaults, featureFlags] = await Promise.all([
      entitlementRepo.find({ where: { planId } }),
      settingRepo.findOne({ where: { planId } }),
      defaultRepo.findOneByOrFail({ id: 1 }),
      this.getFeatureFlags(),
    ]);

    return {
      planId,
      features: entitlements.map((entitlement) => ({
        key: entitlement.featureKey,
        enabled: entitlement.enabled,
        limitValue: entitlement.limitValue === null ? null : Number(entitlement.limitValue),
      })),
      trialWindowDays: setting?.trialWindowDays ?? defaults.defaultTrialWindowDays,
      autoRestrictUnpaid: setting?.autoRestrictUnpaid ?? defaults.defaultAutoRestrictUnpaid,
      featureFlags,
    };
  }

  /**
   * Feature flags gate module *completeness* platform-wide (Constitution Principle VI) and are
   * independent of any plan's entitlements (data-model.md "FeatureFlag" Validation note) — a feature
   * absent from `feature_flag` is not yet gated at all, so it is omitted rather than defaulted to
   * enabled.
   */
  async getFeatureFlags(): Promise<EntitlementSetFeatureFlag[]> {
    const flagRepo = controlDataSource.getRepository(FeatureFlag);
    const flags = await flagRepo.find();
    return flags.map((flag) => ({ key: flag.featureKey, enabled: flag.enabled }));
  }

  /**
   * Used by FeatureFlagGuard (T100) to decide whether a not-yet-complete module's customer-facing
   * surface is reachable. A feature with no `feature_flag` row is treated as not gated (unaffected),
   * matching `getFeatureFlags`'s omission behavior.
   */
  async isFeatureFlagEnabled(featureKey: string): Promise<boolean> {
    const flagRepo = controlDataSource.getRepository(FeatureFlag);
    const flag = await flagRepo.findOne({ where: { featureKey } });
    return flag?.enabled ?? true;
  }

  /**
   * Resolves the caller's plan itself from the DB via the trusted JWT `sub` (never from a
   * client-supplied planId/tenantId), so a caller cannot substitute another account's or
   * tenant's entitlements by shaping the request.
   */
  async getEntitlementSetForAccount(keycloakUserId: string): Promise<EntitlementSet> {
    // Keycloak always mints `sub` as a UUID, but a forged/malformed token must not reach the
    // uuid-typed `keycloak_user_id` column as a raw query param (that would surface as an
    // uncaught DB error / 500 instead of the same 401 an unrecognized-but-well-formed sub gets).
    if (!UUID_PATTERN.test(keycloakUserId)) {
      throw new UnauthorizedException('No account is linked to the authenticated user');
    }
    const accountRepo = controlDataSource.getRepository(Account);
    const account = await accountRepo.findOne({ where: { keycloakUserId } });
    if (!account) {
      throw new UnauthorizedException('No account is linked to the authenticated user');
    }
    if (!account.selectedPlanId) {
      throw new NotFoundException('This account has not selected a plan yet');
    }
    return this.getEntitlementSet(account.selectedPlanId);
  }
}
