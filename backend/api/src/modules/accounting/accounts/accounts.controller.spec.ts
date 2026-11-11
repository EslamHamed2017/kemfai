import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AccountsController } from './accounts.controller';

const COMPANY = '49494949-3333-4333-8333-333333333333';
const ACCOUNT = '49494949-5555-4555-8555-555555555555';
const response = () => ({ setHeader: jest.fn() });

describe('AccountsController safe route boundary (T050)', () => {
  const service = {
    list: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const controller = new AccountsController(service as never);
  const req = { auth: {}, headers: {} } as never;

  beforeEach(() => jest.clearAllMocks());

  it('mounts only the documented collection GET/POST and item GET/PATCH handlers', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AccountsController)).toBe('v1/accounting/accounts');
    const routes = Object.getOwnPropertyNames(AccountsController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = (AccountsController.prototype as unknown as Record<string, unknown>)[name];
        return {
          method: Reflect.getMetadata(METHOD_METADATA, handler as object),
          path: Reflect.getMetadata(PATH_METADATA, handler as object),
        };
      })
      .filter(({ method }) => method !== undefined);
    expect(routes).toEqual([
      { method: RequestMethod.GET, path: '/' },
      { method: RequestMethod.POST, path: '/' },
      { method: RequestMethod.GET, path: ':accountId' },
      { method: RequestMethod.PATCH, path: ':accountId' },
    ]);
  });

  it('delegates scoped reads and emits a strong ETag for an item', async () => {
    service.list.mockResolvedValue({ items: [] });
    service.get.mockResolvedValue({ id: ACCOUNT, version: 3 });
    await expect(
      controller.list(req, COMPANY, 'cursor', '25', 'true', 'posting', 'cash'),
    ).resolves.toEqual({ items: [] });
    expect(service.list).toHaveBeenCalledWith(req, COMPANY, {
      cursor: 'cursor',
      limit: 25,
      active: true,
      nodeKind: 'posting',
      search: 'cash',
    });
    const res = response();
    await expect(controller.get(req, res as never, COMPANY, ACCOUNT)).resolves.toEqual({
      id: ACCOUNT,
      version: 3,
    });
    expect(res.setHeader).toHaveBeenCalledWith('ETag', '"3"');
  });

  it('parses If-Match exactly and emits the resulting ETag for mutations', async () => {
    const result = { resource: { id: ACCOUNT, version: 4 } };
    service.create.mockResolvedValue(result);
    service.update.mockResolvedValue(result);
    const createRes = response();
    await controller.create(req, createRes as never, COMPANY, { code: '1000' } as never);
    expect(createRes.setHeader).toHaveBeenCalledWith('ETag', '"4"');
    const updateRes = response();
    await controller.update(req, updateRes as never, COMPANY, ACCOUNT, '"3"', {
      active: false,
    } as never);
    expect(service.update).toHaveBeenCalledWith(req, COMPANY, ACCOUNT, 3, { active: false });
    expect(updateRes.setHeader).toHaveBeenCalledWith('ETag', '"4"');
  });
});
