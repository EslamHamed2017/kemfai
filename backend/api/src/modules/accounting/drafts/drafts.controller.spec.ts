import { BadRequestException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DraftsController } from './drafts.controller';

const COMPANY = '52525252-3333-4333-8333-333333333333';
const DRAFT = '52525252-5555-4555-8555-555555555555';
const response = () => ({ setHeader: jest.fn() });

describe('DraftsController non-posting route boundary (T052)', () => {
  const service = {
    list: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    get: jest.fn(),
  };
  const validationService = { validate: jest.fn() };
  const controller = new DraftsController(service as never, validationService as never);
  const req = { auth: {}, headers: {} } as never;

  beforeEach(() => jest.clearAllMocks());

  it('mounts exactly the safe draft routes with no posting operation', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DraftsController)).toBe('v1/accounting/drafts');
    const routes = Object.getOwnPropertyNames(DraftsController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = (DraftsController.prototype as unknown as Record<string, unknown>)[name];
        return {
          name,
          method: Reflect.getMetadata(METHOD_METADATA, handler as object),
          path: Reflect.getMetadata(PATH_METADATA, handler as object),
        };
      })
      .filter(({ method }) => method !== undefined);

    expect(routes).toEqual([
      { name: 'list', method: RequestMethod.GET, path: '/' },
      { name: 'save', method: RequestMethod.POST, path: '/' },
      { name: 'update', method: RequestMethod.PUT, path: ':draftId' },
      { name: 'get', method: RequestMethod.GET, path: ':draftId' },
      { name: 'validate', method: RequestMethod.POST, path: ':draftId/validate' },
    ]);
    expect(
      routes.some(({ name, path }) => name.includes('post') || String(path).includes('post')),
    ).toBe(false);
  });

  it('delegates draft save/read and emits strong resource ETags', async () => {
    const saved = { resource: { id: DRAFT, version: 2 }, ledgerEffect: 'none' };
    service.save.mockResolvedValue(saved);
    const saveResponse = response();
    await expect(
      controller.save(req, saveResponse as never, COMPANY, { description: 'safe draft' } as never),
    ).resolves.toBe(saved);
    expect(service.save).toHaveBeenCalledWith(req, COMPANY, { description: 'safe draft' });
    expect(saveResponse.setHeader).toHaveBeenCalledWith('ETag', '"2"');

    const updated = { resource: { id: DRAFT, version: 3 }, ledgerEffect: 'none' };
    service.update.mockResolvedValue(updated);
    const updateResponse = response();
    await expect(
      controller.update(req, updateResponse as never, COMPANY, DRAFT, '"2"', {
        description: 'changed',
      } as never),
    ).resolves.toBe(updated);
    expect(service.update).toHaveBeenCalledWith(req, COMPANY, DRAFT, 2, { description: 'changed' });
    expect(updateResponse.setHeader).toHaveBeenCalledWith('ETag', '"3"');

    const draft = { id: DRAFT, version: 2, ledgerEffect: 'none' };
    service.get.mockResolvedValue(draft);
    const getResponse = response();
    await expect(controller.get(req, getResponse as never, COMPANY, DRAFT)).resolves.toBe(draft);
    expect(service.get).toHaveBeenCalledWith(req, COMPANY, DRAFT);
    expect(getResponse.setHeader).toHaveBeenCalledWith('ETag', '"2"');
  });

  it('requires an exact strong If-Match for validation and emits the validated draft ETag', async () => {
    const validated = { result: { draftVersion: 3 }, ledgerEffect: 'none' };
    validationService.validate.mockResolvedValue(validated);
    const res = response();
    await expect(controller.validate(req, res as never, COMPANY, DRAFT, '"3"')).resolves.toBe(
      validated,
    );
    expect(validationService.validate).toHaveBeenCalledWith(req, COMPANY, DRAFT, 3);
    expect(res.setHeader).toHaveBeenCalledWith('ETag', '"3"');

    await expect(
      controller.validate(req, res as never, COMPANY, DRAFT, '3'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(validationService.validate).toHaveBeenCalledTimes(1);
  });
});
