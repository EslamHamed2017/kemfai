import controlDataSource from '../../database/data-source';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { Plan } from '../entitlements/entities/plan.entity';
import { Feature } from '../entitlements/entities/feature.entity';
import { PlansService } from './plans.service';

/**
 * Pure unit coverage of T031's filtering/shape rules without a real Postgres connection:
 * `controlDataSource.getRepository(Plan)` is stubbed and `EntitlementsService` is a mock
 * collaborator. DB-backed proof against the real schema lives in
 * test/integration/plans-http.integration-spec.ts.
 */
describe('PlansService (T031, unit)', () => {
  function mockRepositories(plans: Partial<Plan>[], features: Partial<Feature>[] = []) {
    jest.spyOn(controlDataSource, 'getRepository').mockImplementation((target: any) => {
      if (target === Plan) {
        return { find: jest.fn().mockResolvedValue(plans) } as any;
      }
      if (target === Feature) {
        return { find: jest.fn().mockResolvedValue(features) } as any;
      }
      throw new Error(`Unexpected repository requested for ${String(target)}`);
    });
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns an empty array when no plan is published (FR-011 empty state, not an error)', async () => {
    mockRepositories([]);
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
    mockRepositories(
      [
        {
          id: 'plan-1',
          name: 'Growth',
          nameEn: 'Growth',
          nameAr: 'النمو',
          monthlyPrice: '1200.00',
          annualPrice: '12000.00',
          currency: 'EGP',
        },
      ],
      [{ key: 'module.accounting', displayNameEn: 'Accounting', displayNameAr: 'المحاسبة' }],
    );
    const entitlementsService = {
      getEntitlementSet: jest.fn().mockResolvedValue({
        planId: 'plan-1',
        features: [
          { key: 'module.accounting', enabled: true, limitValue: 250 },
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
        name: { en: 'Growth', ar: 'النمو' },
        monthlyPrice: 1200,
        annualPrice: 12000,
        currency: 'EGP',
        features: [
          {
            key: 'module.accounting',
            name: { en: 'Accounting', ar: 'المحاسبة' },
            limitValue: 250,
          },
        ],
      },
    ]);
  });

  it('preserves null limitValue for an unlimited enabled feature', async () => {
    mockRepositories(
      [
        {
          id: 'plan-1',
          nameEn: 'Growth',
          nameAr: 'النمو',
          monthlyPrice: '1200.00',
          annualPrice: '12000.00',
          currency: 'EGP',
        },
      ],
      [{ key: 'module.reports', displayNameEn: 'Reports', displayNameAr: 'التقارير' }],
    );
    const entitlementsService = {
      getEntitlementSet: jest.fn().mockResolvedValue({
        planId: 'plan-1',
        features: [{ key: 'module.reports', enabled: true, limitValue: null }],
        trialWindowDays: 14,
        autoRestrictUnpaid: true,
        featureFlags: [],
      }),
    } as unknown as EntitlementsService;

    const [summary] = await new PlansService(entitlementsService).listPublishedPlans();

    expect(summary.features).toEqual([
      { key: 'module.reports', name: { en: 'Reports', ar: 'التقارير' }, limitValue: null },
    ]);
  });

  it('never exposes a published plan or enabled feature with missing Arabic copy', async () => {
    mockRepositories([
      {
        id: 'plan-1',
        nameEn: 'Growth',
        nameAr: null,
        monthlyPrice: '1',
        annualPrice: '10',
        currency: 'USD',
      },
    ]);
    const entitlementsService = { getEntitlementSet: jest.fn() } as unknown as EntitlementsService;

    expect(await new PlansService(entitlementsService).listPublishedPlans()).toEqual([]);
    expect(entitlementsService.getEntitlementSet).not.toHaveBeenCalled();
  });
});
