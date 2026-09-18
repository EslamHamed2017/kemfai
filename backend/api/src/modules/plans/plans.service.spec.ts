import controlDataSource from '../../database/data-source';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { Plan } from '../entitlements/entities/plan.entity';
import { PlansService } from './plans.service';

/**
 * Pure unit coverage of T031's filtering/shape rules without a real Postgres connection:
 * `controlDataSource.getRepository(Plan)` is stubbed and `EntitlementsService` is a mock
 * collaborator. DB-backed proof against the real schema lives in
 * test/integration/plans-http.integration-spec.ts.
 */
describe('PlansService (T031, unit)', () => {
  function mockPlanRepository(plans: Partial<Plan>[]) {
    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: any) => {
      if (target === Plan) {
        return { find: jest.fn().mockResolvedValue(plans) } as any;
      }
      throw new Error(`Unexpected repository requested for ${String(target)}`);
    });
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns an empty array when no plan is published (FR-011 empty state, not an error)', async () => {
    mockPlanRepository([]);
    const entitlementsService = { getEntitlementSet: jest.fn() } as unknown as EntitlementsService;

    const result = await new PlansService(entitlementsService).listPublishedPlans();

    expect(result).toEqual([]);
    expect(entitlementsService.getEntitlementSet).not.toHaveBeenCalled();
  });

  it('only queries plans filtered to published=true — unpublished plans never reach the response', async () => {
    const find = jest.fn().mockResolvedValue([]);
    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: any) => {
      if (target === Plan) {
        return { find } as any;
      }
      throw new Error(`Unexpected repository requested for ${String(target)}`);
    });
    const entitlementsService = { getEntitlementSet: jest.fn() } as unknown as EntitlementsService;

    await new PlansService(entitlementsService).listPublishedPlans();

    expect(find).toHaveBeenCalledWith(expect.objectContaining({ where: { published: true } }));
  });

  it('maps each published plan to the PlanSummary shape, sourcing features from EntitlementsService', async () => {
    mockPlanRepository([
      {
        id: 'plan-1',
        name: 'Growth',
        monthlyPrice: '1200.00',
        annualPrice: '12000.00',
        currency: 'EGP',
      },
    ]);
    const entitlementsService = {
      getEntitlementSet: jest.fn().mockResolvedValue({
        planId: 'plan-1',
        features: [
          { key: 'module.accounting', enabled: true, limitValue: null },
          { key: 'module.disabled', enabled: false, limitValue: null },
        ],
        trialWindowDays: 14,
        autoRestrictUnpaid: true,
        featureFlags: [],
      }),
    } as unknown as EntitlementsService;

    const result = await new PlansService(entitlementsService).listPublishedPlans();

    expect(result).toEqual([
      {
        id: 'plan-1',
        name: 'Growth',
        monthlyPrice: 1200,
        annualPrice: 12000,
        currency: 'EGP',
        features: ['module.accounting'],
      },
    ]);
  });
});
