import { BadRequestException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { JournalsCurrenciesController } from './journals-currencies.controller';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const JOURNAL_ID = '22222222-2222-4222-8222-222222222222';
const req = { auth: { keycloakUserId: 'user-a' } } as never;

function fixture() {
  const service = {
    listJournals: jest.fn(),
    createJournal: jest.fn(),
    updateJournal: jest.fn(),
    listCurrencies: jest.fn(),
    putCurrencyConfiguration: jest.fn(),
  };
  return { controller: new JournalsCurrenciesController(service as never), service };
}

function response() {
  return { setHeader: jest.fn(), status: jest.fn().mockReturnThis() };
}

describe('JournalsCurrenciesController safe routes (T125)', () => {
  it('declares only the accepted journal and currency route verbs', () => {
    expect(Reflect.getMetadata(PATH_METADATA, JournalsCurrenciesController)).toBe('v1/accounting');
    const routes = Object.getOwnPropertyNames(JournalsCurrenciesController.prototype)
      .filter((name) => name !== 'constructor')
      .flatMap((name) => {
        const handler =
          JournalsCurrenciesController.prototype[name as keyof JournalsCurrenciesController];
        const method = Reflect.getMetadata(METHOD_METADATA, handler as object);
        const path = Reflect.getMetadata(PATH_METADATA, handler as object);
        return method === undefined ? [] : [[RequestMethod[method], path]];
      });
    expect(routes).toEqual([
      ['GET', 'journals'],
      ['POST', 'journals'],
      ['PATCH', 'journals/:journalId'],
      ['GET', 'currencies'],
      ['PUT', 'currencies/:currencyCode'],
    ]);
  });

  it('strictly parses filters and strong journal ETags', async () => {
    const { controller, service } = fixture();
    service.listJournals.mockResolvedValue({ items: [] });
    await controller.listJournals(req, COMPANY_ID, 'false');
    expect(service.listJournals).toHaveBeenCalledWith(req, COMPANY_ID, { active: false });
    expect(() => controller.listJournals(req, COMPANY_ID, '1')).toThrow(BadRequestException);

    service.updateJournal.mockResolvedValue({ resource: { version: 2 } });
    const res = response();
    await controller.updateJournal(req, res as never, COMPANY_ID, JOURNAL_ID, '"1"', {
      active: false,
    });
    expect(service.updateJournal).toHaveBeenCalledWith(req, COMPANY_ID, JOURNAL_ID, 1, {
      active: false,
    });
    expect(res.setHeader).toHaveBeenCalledWith('ETag', '"2"');
    await expect(
      controller.updateJournal(req, response() as never, COMPANY_ID, JOURNAL_ID, '*', {
        active: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('preserves create-only star and exact currency update ETags with correct status', async () => {
    const { controller, service } = fixture();
    service.putCurrencyConfiguration.mockResolvedValue({ resource: { version: 1 } });
    const created = response();
    await controller.putCurrency(req, created as never, COMPANY_ID, 'AED', '*', { enabled: true });
    expect(service.putCurrencyConfiguration).toHaveBeenCalledWith(req, COMPANY_ID, 'AED', '*', {
      enabled: true,
    });
    expect(created.status).toHaveBeenCalledWith(201);
    expect(created.setHeader).toHaveBeenCalledWith('ETag', '"1"');

    service.putCurrencyConfiguration.mockResolvedValue({ resource: { version: 2 } });
    const updated = response();
    await controller.putCurrency(req, updated as never, COMPANY_ID, 'AED', '"1"', {
      enabled: false,
    });
    expect(updated.status).toHaveBeenCalledWith(200);
    expect(updated.setHeader).toHaveBeenCalledWith('ETag', '"2"');
    await expect(
      controller.putCurrency(req, response() as never, COMPANY_ID, 'aed', '*', { enabled: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
