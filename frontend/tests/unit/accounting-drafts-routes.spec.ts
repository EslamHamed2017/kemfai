/** @jest-environment node */
const forwardAccounting = jest.fn();

jest.mock('../../src/lib/auth/accounting-bff', () => ({
  forwardAccounting: (...args: unknown[]) => forwardAccounting(...args),
}));

import * as item from '../../src/app/api/accounting/v1/drafts/[draftId]/route';
import * as validate from '../../src/app/api/accounting/v1/drafts/[draftId]/validate/route';

const companyId = '22222222-2222-4222-8222-222222222222';
const draftId = '33333333-3333-4333-8333-333333333333';

const draft = {
  journalId: '66666666-6666-4666-8666-666666666666',
  accountingDate: '2026-11-07',
  description: 'Exact money preservation',
  transactionType: 'manual_journal',
  source: { type: 'manual', id: '77777777-7777-4777-8777-777777777777' },
  lines: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      sequence: 1,
      accountId: '55555555-5555-4555-8555-555555555555',
      transactionCurrencyCode: 'EUR',
      transactionPrecision: 2,
      transactionCurrencyMetadataVersion: 'iso-4217-v1',
      companyBaseCurrencyCode: 'USD',
      basePrecision: 2,
      baseCurrencyMetadataVersion: 'iso-4217-v1',
      currencyConfigurationVersion: 7,
      transactionDebit: '123.4500',
      transactionCredit: '0.0000',
      baseDebit: '133.333300',
      baseCredit: '0.000000',
      rateReference: 'ECB-2026-11-07',
      rateEffectiveDate: '2026-11-07',
      dimensions: [],
    },
  ],
};

beforeEach(() => {
  forwardAccounting.mockReset();
  forwardAccounting.mockResolvedValue(new Response(null, { status: 204 }));
});

describe('T132 draft item BFF route', () => {
  test('GET encodes the draft ID and preserves company context', async () => {
    const request = new Request('https://app.test/api/accounting/v1/drafts/unsafe', {
      headers: { 'x-kemfai-company-id': companyId },
    });

    await expect(
      item.GET(request, { params: Promise.resolve({ draftId: '../' }) }),
    ).resolves.toMatchObject({ status: 204 });
    expect(forwardAccounting).toHaveBeenCalledWith(request, {
      method: 'GET',
      path: '/drafts/..%2F',
    });
  });

  test('PUT preserves exact decimal strings, snapshots, idempotency, and ETag', async () => {
    const request = new Request(`https://app.test/api/accounting/v1/drafts/${draftId}`, {
      method: 'PUT',
      headers: {
        origin: 'https://app.test',
        'content-type': 'application/json',
        'idempotency-key': 'draft-replace-1',
        'if-match': '"7"',
        'x-kemfai-company-id': companyId,
      },
      body: JSON.stringify(draft),
    });

    await expect(
      item.PUT(request, { params: Promise.resolve({ draftId }) }),
    ).resolves.toMatchObject({ status: 204 });
    expect(forwardAccounting).toHaveBeenCalledWith(request, {
      method: 'PUT',
      path: `/drafts/${draftId}`,
      body: draft,
    });
    expect(request.headers.get('if-match')).toBe('"7"');
    expect(request.headers.get('idempotency-key')).toBe('draft-replace-1');
    expect(draft.lines[0].transactionDebit).toBe('123.4500');
    expect(draft.lines[0].baseDebit).toBe('133.333300');
  });
});

describe('T132 draft validation BFF route', () => {
  test('POST preserves validation options, receipt headers, and encoded draft ID', async () => {
    const body = { includePostingReadinessBlockers: true };
    const request = new Request(
      'https://app.test/api/accounting/v1/drafts/unsafe/validate',
      {
        method: 'POST',
        headers: {
          origin: 'https://app.test',
          'content-type': 'application/json',
          'idempotency-key': 'draft-validate-1',
          'if-match': '"8"',
          'x-kemfai-company-id': companyId,
        },
        body: JSON.stringify(body),
      },
    );

    await expect(
      validate.POST(request, { params: Promise.resolve({ draftId: '../' }) }),
    ).resolves.toMatchObject({ status: 204 });
    expect(forwardAccounting).toHaveBeenCalledWith(request, {
      method: 'POST',
      path: '/drafts/..%2F/validate',
      body,
    });
    expect(request.headers.get('idempotency-key')).toBe('draft-validate-1');
  });

  test('POST supports the contract optional empty body without inventing options', async () => {
    const request = new Request(
      `https://app.test/api/accounting/v1/drafts/${draftId}/validate`,
      {
        method: 'POST',
        headers: {
          origin: 'https://app.test',
          'idempotency-key': 'draft-validate-2',
          'if-match': '"8"',
          'x-kemfai-company-id': companyId,
        },
      },
    );

    await validate.POST(request, { params: Promise.resolve({ draftId }) });
    expect(forwardAccounting).toHaveBeenCalledWith(request, {
      method: 'POST',
      path: `/drafts/${draftId}/validate`,
    });
  });
});
