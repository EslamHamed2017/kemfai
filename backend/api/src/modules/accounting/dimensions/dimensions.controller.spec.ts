import { BadRequestException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  DimensionDefinitionsController,
  DimensionRulesController,
  DimensionValuesController,
} from './dimensions.controller';

const COMPANY = '93939393-3333-4333-8333-333333333333';
const RESOURCE = '93939393-5555-4555-8555-555555555555';
const DEFINITION = '93939393-6666-4666-8666-666666666666';
const response = () => ({ setHeader: jest.fn() });

function routes(controller: object) {
  const prototype = controller as Record<string, unknown>;
  return Object.getOwnPropertyNames(controller)
    .filter((name) => name !== 'constructor')
    .map((name) => ({
      method: Reflect.getMetadata(METHOD_METADATA, prototype[name] as object),
      path: Reflect.getMetadata(PATH_METADATA, prototype[name] as object),
    }))
    .filter(({ method }) => method !== undefined);
}

describe('Dimension controllers exact safe route boundary (T093)', () => {
  const service = {
    listDefinitions: jest.fn(),
    createDefinition: jest.fn(),
    updateDefinition: jest.fn(),
    listValues: jest.fn(),
    createValue: jest.fn(),
    updateValue: jest.fn(),
    listRules: jest.fn(),
    createRule: jest.fn(),
    updateRule: jest.fn(),
  };
  const definitions = new DimensionDefinitionsController(service as never);
  const values = new DimensionValuesController(service as never);
  const rules = new DimensionRulesController(service as never);
  const req = { auth: {}, headers: {} } as never;

  beforeEach(() => jest.clearAllMocks());

  it('mounts only documented GET/POST collection and PATCH item routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DimensionDefinitionsController)).toBe(
      'v1/accounting/dimension-definitions',
    );
    expect(Reflect.getMetadata(PATH_METADATA, DimensionValuesController)).toBe(
      'v1/accounting/dimension-values',
    );
    expect(Reflect.getMetadata(PATH_METADATA, DimensionRulesController)).toBe(
      'v1/accounting/dimension-rules',
    );
    const collectionRoutes = [
      { method: RequestMethod.GET, path: '/' },
      { method: RequestMethod.POST, path: '/' },
    ];
    expect(routes(DimensionDefinitionsController.prototype)).toEqual([
      ...collectionRoutes,
      { method: RequestMethod.PATCH, path: ':definitionId' },
    ]);
    expect(routes(DimensionValuesController.prototype)).toEqual([
      ...collectionRoutes,
      { method: RequestMethod.PATCH, path: ':valueId' },
    ]);
    expect(routes(DimensionRulesController.prototype)).toEqual([
      ...collectionRoutes,
      { method: RequestMethod.PATCH, path: ':ruleId' },
    ]);
    expect(JSON.stringify([definitions, values, rules])).not.toMatch(/delete|post|approve|period/i);
  });

  it('parses scoped collection filters exactly', async () => {
    service.listDefinitions.mockResolvedValue({ items: [] });
    service.listValues.mockResolvedValue({ items: [] });
    service.listRules.mockResolvedValue({ items: [] });
    await definitions.list(req, COMPANY, 'true');
    expect(service.listDefinitions).toHaveBeenCalledWith(req, COMPANY, { active: true });
    await values.list(req, COMPANY, 'cursor', '25', DEFINITION, 'false');
    expect(service.listValues).toHaveBeenCalledWith(req, COMPANY, {
      cursor: 'cursor',
      limit: 25,
      definitionId: DEFINITION,
      active: false,
    });
    await rules.list(req, COMPANY, RESOURCE, 'manual_journal', 'true');
    expect(service.listRules).toHaveBeenCalledWith(req, COMPANY, {
      accountId: RESOURCE,
      transactionType: 'manual_journal',
      active: true,
    });
  });

  it('uses exact strong If-Match and emits resource ETags for all mutations', async () => {
    const result = { resource: { id: RESOURCE, version: 4 } };
    for (const method of [
      service.createDefinition,
      service.updateDefinition,
      service.createValue,
      service.updateValue,
      service.createRule,
      service.updateRule,
    ])
      method.mockResolvedValue(result);

    const createRes = response();
    await definitions.create(req, createRes as never, COMPANY, { key: 'custom' } as never);
    expect(createRes.setHeader).toHaveBeenCalledWith('ETag', '\"4\"');

    for (const [controller, update] of [
      [definitions, service.updateDefinition],
      [values, service.updateValue],
      [rules, service.updateRule],
    ] as const) {
      const res = response();
      await controller.update(req, res as never, COMPANY, RESOURCE, '"3"', {
        active: false,
      } as never);
      expect(update).toHaveBeenCalledWith(req, COMPANY, RESOURCE, 3, { active: false });
      expect(res.setHeader).toHaveBeenCalledWith('ETag', '\"4\"');
    }
  });

  it('rejects malformed query filters and weak or unsafe ETags', async () => {
    await expect(definitions.list(req, COMPANY, 'yes')).rejects.toBeInstanceOf(BadRequestException);
    await expect(values.list(req, COMPANY, undefined, '0')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      values.list(req, COMPANY, undefined, undefined, 'not-a-uuid'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(rules.list(req, COMPANY, undefined, ' '.repeat(2))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      definitions.update(req, response() as never, COMPANY, RESOURCE, 'W/"3"', {} as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
