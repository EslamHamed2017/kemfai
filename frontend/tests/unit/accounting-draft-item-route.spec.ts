/** @jest-environment node */
const forwardAccounting = jest.fn();

jest.mock('../../src/lib/auth/accounting-bff', () => ({
  forwardAccounting: (...args: unknown[]) => forwardAccounting(...args),
}));

import { GET } from '../../src/app/api/accounting/v1/drafts/[draftId]/route';
import { POST as VALIDATE } from '../../src/app/api/accounting/v1/drafts/[draftId]/validate/route';

const draftId = '55555555-5555-4555-8555-555555555555';
const lineId = '66666666-6666-4666-8666-666666666666';
const context = { params: Promise.resolve({ draftId }) };

beforeEach(() => {
  forwardAccounting.mockReset();
});

test('T060 GET delegates the exact encoded draft item path and preserves its response', async () => {
  const expected = Response.json(
    {
      id: draftId,
      version: 3,
      status: 'draft',
      lines: [{ id: lineId, accountId: '77777777-7777-4777-8777-777777777777' }],
      ledgerEffect: 'none',
    },
    { headers: { etag: '"3"' } },
  );
  forwardAccounting.mockResolvedValue(expected);
  const request = new Request(`https://app.test/api/accounting/v1/drafts/${draftId}`, {
    headers: { 'x-kemfai-company-id': '22222222-2222-4222-8222-222222222222' },
  });

  await expect(GET(request, context)).resolves.toBe(expected);
  expect(forwardAccounting).toHaveBeenCalledWith(request, {
    method: 'GET',
    path: `/drafts/${draftId}`,
  });
});

test('T060 GET encodes the draft parameter so it cannot widen the fixed draft boundary', async () => {
  forwardAccounting.mockResolvedValue(new Response(null, { status: 204 }));
  const request = new Request('https://app.test/api/accounting/v1/drafts/unsafe');

  await GET(request, { params: Promise.resolve({ draftId: '../accounts' }) });

  expect(forwardAccounting).toHaveBeenCalledWith(request, {
    method: 'GET',
    path: '/drafts/..%2Faccounts',
  });
});

test('T060 validate preserves line-specific parent errors from the authenticated BFF', async () => {
  const expected = Response.json(
    {
      statusCode: 422,
      code: 'DRAFT_VALIDATION_FAILED',
      messageKey: 'accounting.errors.draftValidationFailed',
      correlationId: '88888888-8888-4888-8888-888888888888',
      issues: [
        {
          code: 'ACCOUNT_NOT_POSTING',
          messageKey: 'accounting.validation.accountNotPosting',
          lineId,
          resourceId: '99999999-9999-4999-8999-999999999999',
          field: 'accountId',
        },
      ],
    },
    { status: 422 },
  );
  forwardAccounting.mockResolvedValue(expected);
  const request = new Request(
    `https://app.test/api/accounting/v1/drafts/${draftId}/validate`,
    {
      method: 'POST',
      headers: {
        origin: 'https://app.test',
        'idempotency-key': 'validate-parent-001',
        'if-match': '"3"',
        'x-kemfai-company-id': '22222222-2222-4222-8222-222222222222',
      },
    },
  );

  await expect(VALIDATE(request, context)).resolves.toBe(expected);
  expect(forwardAccounting).toHaveBeenCalledWith(request, {
    method: 'POST',
    path: `/drafts/${draftId}/validate`,
  });
  expect(request.headers.get('idempotency-key')).toBe('validate-parent-001');
  expect(request.headers.get('if-match')).toBe('"3"');
});

test('T060 validate preserves the receipt, ETag, and zero-ledger result without a body rewrite', async () => {
  const receipt = {
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    auditEventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    correlationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    replayed: false,
    result: {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      draftId,
      draftVersion: 4,
      status: 'invalid',
      errors: [
        {
          code: 'ACCOUNT_NOT_POSTING',
          messageKey: 'accounting.validation.accountNotPosting',
          lineId,
          resourceId: '99999999-9999-4999-8999-999999999999',
          field: 'accountId',
        },
      ],
    },
    ledgerEffect: 'none',
  };
  const expected = Response.json(receipt, { headers: { etag: '"4"' } });
  forwardAccounting.mockResolvedValue(expected);
  const request = new Request(
    `https://app.test/api/accounting/v1/drafts/${draftId}/validate`,
    {
      method: 'POST',
      headers: {
        origin: 'https://app.test',
        'idempotency-key': 'validate-parent-002',
        'if-match': '"3"',
        'x-kemfai-company-id': '22222222-2222-4222-8222-222222222222',
      },
    },
  );

  await expect(VALIDATE(request, context)).resolves.toBe(expected);
  expect(expected.headers.get('etag')).toBe('"4"');
  await expect(expected.json()).resolves.toEqual(receipt);
  expect(forwardAccounting).toHaveBeenCalledWith(request, {
    method: 'POST',
    path: `/drafts/${draftId}/validate`,
  });
});
