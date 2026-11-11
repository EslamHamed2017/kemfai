/** @jest-environment node */
const forwardAccounting = jest.fn();

jest.mock('../../src/lib/auth/accounting-bff', () => ({
  forwardAccounting: (...args: unknown[]) => forwardAccounting(...args),
}));

import { POST } from '../../src/app/api/accounting/v1/drafts/route';

beforeEach(() => {
  forwardAccounting.mockReset();
  forwardAccounting.mockResolvedValue(new Response(null, { status: 204 }));
});

test('T059 POST preserves the stable idempotency key, exact company context, and draft body', async () => {
  const body = {
    journalId: '11111111-1111-4111-8111-111111111111',
    accountingDate: '2026-11-03',
    description: 'Exact draft save',
    transactionType: 'manual_journal',
    source: null,
    lines: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        sequence: 1,
        accountId: '33333333-3333-4333-8333-333333333333',
        transactionCurrencyCode: 'AED',
        transactionPrecision: 2,
        transactionCurrencyMetadataVersion: 'aed-v1',
        companyBaseCurrencyCode: 'AED',
        basePrecision: 2,
        baseCurrencyMetadataVersion: 'aed-v1',
        currencyConfigurationVersion: 1,
        transactionDebit: '100.0000',
        transactionCredit: '0.0000',
        baseDebit: '100.0000',
        baseCredit: '0.0000',
        rateReference: null,
        rateEffectiveDate: null,
        dimensions: [],
      },
    ],
  };
  const companyId = '44444444-4444-4444-8444-444444444444';
  const idempotencyKey = 'draft-save-stable-001';
  const request = new Request('https://app.test/api/accounting/v1/drafts', {
    method: 'POST',
    headers: {
      origin: 'https://app.test',
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-kemfai-company-id': companyId,
    },
    body: JSON.stringify(body),
  });

  await expect(POST(request)).resolves.toMatchObject({ status: 204 });
  expect(forwardAccounting).toHaveBeenCalledTimes(1);
  expect(forwardAccounting).toHaveBeenCalledWith(request, {
    method: 'POST',
    path: '/drafts',
    body,
  });
  expect(request.headers.get('idempotency-key')).toBe(idempotencyKey);
  expect(request.headers.get('x-kemfai-company-id')).toBe(companyId);
  expect(forwardAccounting.mock.calls[0][1].body.lines[0]).toEqual(
    expect.objectContaining({
      transactionDebit: '100.0000',
      transactionCredit: '0.0000',
      baseDebit: '100.0000',
      baseCredit: '0.0000',
    }),
  );
});
