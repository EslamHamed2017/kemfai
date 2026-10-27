import { assertAuditSourceLinked, AuditLinkQuery } from './audit-source-linkage';

describe('T093 audit source resolver', () => {
  const tenantId = '10000000-0000-4000-8000-000000000001';
  const paymentId = '10000000-0000-4000-8000-000000000002';
  const sourceEntry = {
    status: 'Approved',
    changedAt: '2026-01-01T00:00:00.000Z',
    changedBy: 'reviewer',
    notes: null,
  };

  function paymentDb(history: unknown): AuditLinkQuery {
    return {
      query: jest.fn(async (sql: string) =>
        sql.includes('status_history') ? [{ status_history: history }] : [{ id: paymentId }],
      ),
    };
  }

  const event = {
    action: 'billing.payment_submission.decided',
    subjectType: 'payment_submission',
    subjectId: paymentId,
    tenantId,
    payload: { status_history: [sourceEntry] },
  };

  it('accepts a non-empty exact structural history entry independent of object key order', async () => {
    await expect(
      assertAuditSourceLinked(
        paymentDb([
          {
            notes: sourceEntry.notes,
            changedBy: sourceEntry.changedBy,
            status: sourceEntry.status,
            changedAt: sourceEntry.changedAt,
          },
        ]),
        event,
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    ['empty', []],
    ['malformed', 'not-an-array'],
    ['fabricated', [{ ...sourceEntry, fabricated: true }]],
  ])('rejects %s audited history', async (_label, status_history) => {
    await expect(
      assertAuditSourceLinked(paymentDb([sourceEntry]), {
        ...event,
        payload: { status_history },
      }),
    ).rejects.toThrow(/history/);
  });

  it('rejects unknown subject types without a type-wide exemption', async () => {
    await expect(
      assertAuditSourceLinked(paymentDb([]), { ...event, subjectType: 'test' }),
    ).rejects.toThrow(/unrecognized/);
  });
});
