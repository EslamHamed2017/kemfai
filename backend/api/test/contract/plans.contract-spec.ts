import { OpenApiContractValidator } from '../support/openapi-contract-validator';

describe('Plans contract (T036, FR-016)', () => {
  const validator = new OpenApiContractValidator();

  it('accepts limited and unlimited features in a PlanSummary response', () => {
    expect(() =>
      validator.assertResponse('/public/plans', 'get', 200, [
        {
          id: '11111111-1111-1111-1111-111111111111',
          name: { en: 'Growth', ar: 'النمو' },
          monthlyPrice: 100,
          annualPrice: 1000,
          currency: 'USD',
          features: [
            {
              key: 'limit.users',
              name: { en: 'Users', ar: 'المستخدمون' },
              limitValue: 25,
            },
            {
              key: 'module.accounting',
              name: { en: 'Accounting', ar: 'المحاسبة' },
              limitValue: null,
            },
          ],
        },
      ]),
    ).not.toThrow();
  });

  it('rejects a feature that omits limitValue', () => {
    expect(() =>
      validator.assertResponse('/public/plans', 'get', 200, [
        {
          id: '11111111-1111-1111-1111-111111111111',
          name: { en: 'Growth', ar: 'النمو' },
          monthlyPrice: 100,
          annualPrice: 1000,
          currency: 'USD',
          features: [
            {
              key: 'limit.users',
              name: { en: 'Users', ar: 'المستخدمون' },
            },
          ],
        },
      ]),
    ).toThrow(/limitValue/);
  });
});
