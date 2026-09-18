import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { Account } from '../accounts/entities/account.entity';
import { EntitlementDefault } from './entities/entitlement-default.entity';
import { PlanFeatureEntitlement } from './entities/plan-feature-entitlement.entity';
import { PlanSetting } from './entities/plan-setting.entity';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EntitlementSetFeature {
  key: string;
  enabled: boolean;
  limitValue: number | null;
}

export interface EntitlementSet {
  planId: string;
  features: EntitlementSetFeature[];
  trialWindowDays: number;
  autoRestrictUnpaid: boolean;
}

/**
 * The only service permitted to read PlanFeatureEntitlement/PlanSetting/EntitlementDefault
 * (T010 acceptance criteria, FR-030/FR-030a) — every later module-selection, checklist-gating,
 * or trial/auto-restriction check must call this instead of querying those tables directly.
 */
@Injectable()
export class EntitlementsService {
  async getEntitlementSet(planId: string): Promise<EntitlementSet> {
    const entitlementRepo = controlDataSource.getRepository(PlanFeatureEntitlement);
    const settingRepo = controlDataSource.getRepository(PlanSetting);
    const defaultRepo = controlDataSource.getRepository(EntitlementDefault);

    const [entitlements, setting, defaults] = await Promise.all([
      entitlementRepo.find({ where: { planId } }),
      settingRepo.findOne({ where: { planId } }),
      defaultRepo.findOneByOrFail({ id: 1 }),
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
    };
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
